/**
 * usePay.ts — TanStack Query hooks over pay.api.
 *
 * Keys come from `qk.pay.*` only.
 *
 * Payroll data changes rarely (a released run is immutable) but is sensitive, so
 * these hooks lean on the client's default `staleTime` rather than polling, and
 * every money field they return is integer paise for `<Money>` to render masked.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { requireEmployeeId, useEmployeeId } from "@/shared/api/employee-scope";
import {
  fetchCurrentSalary,
  fetchCurrentSalaryRevision,
  fetchLatestPayslip,
  fetchMyEmployeeRef,
  fetchMyPayoutAccount,
  fetchMyStatutoryMasked,
  fetchPayslipIssuer,
  fetchPayslipLines,
  fetchPayslipLinesByPeriod,
  fetchPayslipPdf,
  fetchPayslips,
  fetchSalaryRevisions,
  type BankMasked,
  type CurrentSalaryLine,
  type EmployeeRef,
  type PayslipIssuer,
  type PayslipLineRow,
  type PayslipPdf,
  type PayslipSummary,
  type SalaryRevision,
  type StatutoryMasked,
} from "../api/pay.api";

const NO_EMPLOYEE = "no-employee";

/**
 * Released payslips, newest first. Drafts are excluded by the base table's own
 * RLS (`self AND run released`), not by a client filter — so there is no way to
 * forget it.
 */
export function usePayslips(limit = 36): UseQueryResult<PayslipSummary[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.pay.payslips(employeeId ?? NO_EMPLOYEE),
    queryFn: ({ signal }) => fetchPayslips(requireEmployeeId(employeeId), limit, signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/** The most recent released payslip — the home tile (net pay masked). */
export function useLatestPayslip(): UseQueryResult<PayslipSummary | null, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.pay.latestPayslip(employeeId ?? NO_EMPLOYEE),
    queryFn: ({ signal }) => fetchLatestPayslip(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/**
 * All rows of one payslip by id. Line grain: header columns repeat on every row,
 * so read totals from the header fields (`gross_earnings_paise`,
 * `total_deductions_paise`, `net_pay_paise`) — never by summing the lines.
 */
export function usePayslipLines(
  payslipId: string | undefined,
): UseQueryResult<PayslipLineRow[], Error> {
  const id = payslipId ?? "";
  return useQuery({
    queryKey: qk.pay.payslipLines(id),
    queryFn: ({ signal }) => fetchPayslipLines(id, signal),
    enabled: id.length > 0,
    retry: shouldRetryQuery,
  });
}

/** The same, keyed by pay-period code — the `/me/payslips/:period` route. */
export function usePayslipByPeriod(
  payPeriodCode: string | undefined,
): UseQueryResult<PayslipLineRow[], Error> {
  const employeeId = useEmployeeId();
  const period = payPeriodCode ?? "";
  return useQuery({
    queryKey: qk.pay.payslipByPeriod(employeeId ?? NO_EMPLOYEE, period),
    queryFn: ({ signal }) =>
      fetchPayslipLinesByPeriod(requireEmployeeId(employeeId), period, signal),
    enabled: employeeId !== null && period.length > 0,
    retry: shouldRetryQuery,
  });
}

/**
 * The salary structure in force today, all component lines. Spec E-08 Card A
 * renders it whole (no pagination); the A/B/C bucket totals arrive as view
 * columns on every row.
 */
export function useCurrentSalary(): UseQueryResult<CurrentSalaryLine[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.pay.structure(employeeId ?? NO_EMPLOYEE),
    queryFn: ({ signal }) => fetchCurrentSalary(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/** Revision history, oldest first — the order the CTC timeline plots. */
export function useSalaryRevisions(): UseQueryResult<SalaryRevision[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.pay.revisions(employeeId ?? NO_EMPLOYEE),
    queryFn: ({ signal }) => fetchSalaryRevisions(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/**
 * The revision in force today — Card B. `null` = never revised; spec E-08 says
 * omit the percentage row entirely rather than showing 0%.
 */
export function useCurrentSalaryRevision(): UseQueryResult<SalaryRevision | null, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.pay.currentRevision(employeeId ?? NO_EMPLOYEE),
    queryFn: ({ signal }) => fetchCurrentSalaryRevision(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Payslip masthead. These use `qk.pay.detail(...)` (the domain's standard
// detail key) rather than new entries in the shared key factory.
// -----------------------------------------------------------------------------

/** The issuing legal entity — reference data, so it outlives a session. */
export function usePayslipIssuer(): UseQueryResult<PayslipIssuer | null, Error> {
  return useQuery({
    queryKey: qk.pay.detail("issuer"),
    queryFn: ({ signal }) => fetchPayslipIssuer(signal),
    staleTime: 60 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

/** Own designation / department / work location for the masthead. */
export function useMyEmployeeRef(): UseQueryResult<EmployeeRef | null, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.pay.detail(`employee-ref:${employeeId ?? NO_EMPLOYEE}`),
    queryFn: ({ signal }) => fetchMyEmployeeRef(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/** Statutory identifiers, already masked by the view. Never unmaskable here. */
export function useMyStatutoryMasked(): UseQueryResult<StatutoryMasked | null, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.pay.detail(`statutory:${employeeId ?? NO_EMPLOYEE}`),
    queryFn: ({ signal }) => fetchMyStatutoryMasked(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/** The active salary payout account, last-4 only. */
export function useMyPayoutAccount(): UseQueryResult<BankMasked | null, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.pay.detail(`payout-account:${employeeId ?? NO_EMPLOYEE}`),
    queryFn: ({ signal }) => fetchMyPayoutAccount(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/**
 * A signed URL for the published PDF. Disabled until the caller asks (the URL
 * lives 120s, so it must be minted on the click, not on page load).
 */
export function usePayslipPdf(
  documentId: string | null,
  enabled: boolean,
): UseQueryResult<PayslipPdf | null, Error> {
  const id = documentId ?? "";
  return useQuery({
    queryKey: qk.pay.detail(`pdf:${id}`),
    queryFn: ({ signal }) => fetchPayslipPdf(id, signal),
    enabled: enabled && id.length > 0,
    gcTime: 0,
    staleTime: 0,
    retry: shouldRetryQuery,
  });
}
