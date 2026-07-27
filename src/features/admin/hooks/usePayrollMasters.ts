/**
 * usePayrollMasters.ts — TanStack hooks for the six payroll master/register
 * screens: components, structures, revisions, payslips, the wage register and
 * the variance report.
 *
 * Everything here is a READ. The tables behind these screens are written by
 * the compute engine, the seed, or the ceremonies on the run detail screen —
 * never from a register grid.
 *
 * Keys: every one is under the `["admin","payroll",…]` prefix (via `qk.admin.*`
 * or a literal that carries the same prefix), so `qk.admin.payrollAll()`
 * invalidation after a compute/publish refreshes these registers too.
 *
 * Counts come from `selectCount` over the SAME filter array as the list —
 * `rows.length` never becomes a headline figure.
 */
import { useMemo } from "react";
import {
  useInfiniteQuery,
  useQuery,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery, type Cursor, type Page } from "@/shared/api/query";
import type { StatusChipEntry } from "@/shared/ui/StatusChip";
import { t } from "@/shared/i18n/en";
import {
  fetchPayrollRuns,
  fetchSalaryComponents,
  fetchSalaryRevisions,
  type PayrollRun,
  type RevisionRow,
  type SalaryComponent,
} from "../api/payroll.api";
import {
  countPayslipRegister,
  countSalaryRevisions,
  countVarianceRows,
  fetchPayslipRegister,
  fetchPeriodPayslips,
  fetchSalaryStructures,
  fetchStructureLines,
  type PayslipHeader,
  type PayslipPaymentStatus,
  type PayslipRegisterFilters,
  type RevisionRegisterFilters,
  type RevisionStatus,
  type SalaryStructure,
  type StructureLine,
} from "../api/payroll-masters.api";

export const REGISTER_PAGE_SIZE = 50;

/**
 * The row limit `fetchPayrollVariance` (payroll.api.ts) asks Postgres for. Kept
 * here so the variance screen can SAY it is showing a capped list instead of
 * silently presenting 2,000 rows as "all of them".
 */
export const VARIANCE_ROW_CAP = 2000;

// -----------------------------------------------------------------------------
// Display vocabulary — every server enum these six screens print (D-10/DR-53)
//
// Nothing here computes: each map turns one stored value into one catalogue
// string. They live beside the hooks because five of the six screens share
// them, and a second copy of "what pct_of_ctc is called" is how two screens
// start disagreeing about the same component.
// -----------------------------------------------------------------------------

/** `public.payslip_line_kind` — what a component contributes to a payslip. */
export const LINE_KIND_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  earning: { label: t("admin.paycomp.kind.earning"), tone: "success" },
  deduction: { label: t("admin.paycomp.kind.deduction"), tone: "danger" },
  employer_contribution: { label: t("admin.paycomp.kind.employer_contribution"), tone: "info" },
  reimbursement: { label: t("admin.paycomp.kind.reimbursement"), tone: "info" },
  informational: { label: t("admin.paycomp.kind.informational"), tone: "neutral" },
  arrear: { label: t("admin.paycomp.kind.arrear"), tone: "warn" },
  recovery: { label: t("admin.paycomp.kind.recovery"), tone: "warn" },
};

/** `ck_salary_components__calc_kind` (020 §1) and `ck_ssc__calc_kind_override` (§3). */
export const CALC_KIND_LABELS: Readonly<Record<string, string>> = {
  fixed: t("admin.paycomp.calc.fixed"),
  pct_of_component: t("admin.paycomp.calc.pct_of_component"),
  pct_of_gross: t("admin.paycomp.calc.pct_of_gross"),
  pct_of_ctc: t("admin.paycomp.calc.pct_of_ctc"),
  balance: t("admin.paycomp.calc.balance"),
  formula: t("admin.paycomp.calc.formula"),
  slab: t("admin.paycomp.calc.slab"),
  attendance_prorated: t("admin.paycomp.calc.attendance_prorated"),
  per_minute: t("admin.paycomp.calc.per_minute"),
  per_unit: t("admin.paycomp.calc.per_unit"),
};

export function calcKindLabel(kind: string): string {
  return CALC_KIND_LABELS[kind] ?? kind;
}

/** `ck_salary_structures__kind` (020 §2) — what the structure is driven from. */
export const STRUCTURE_KIND_LABELS: Readonly<Record<string, string>> = {
  ctc_based: t("admin.struct.kind.ctc_based"),
  gross_based: t("admin.struct.kind.gross_based"),
  wage_based: t("admin.struct.kind.wage_based"),
};

/** `public.approval_status` (003) — every state a salary revision can be in. */
export const REVISION_STATUS_CHIP: Readonly<Record<RevisionStatus, StatusChipEntry>> = {
  draft: { label: t("admin.rev.status.draft"), tone: "neutral" },
  pending: { label: t("admin.rev.status.pending"), tone: "warn" },
  in_progress: { label: t("admin.rev.status.in_progress"), tone: "info" },
  approved: { label: t("admin.rev.status.approved"), tone: "success" },
  rejected: { label: t("admin.rev.status.rejected"), tone: "danger" },
  cancelled: { label: t("admin.rev.status.cancelled"), tone: "neutral" },
  withdrawn: { label: t("admin.rev.status.withdrawn"), tone: "neutral" },
  expired: { label: t("admin.rev.status.expired"), tone: "neutral" },
  auto_approved: { label: t("admin.rev.status.auto_approved"), tone: "success" },
  escalated: { label: t("admin.rev.status.escalated"), tone: "warn" },
  applied: { label: t("admin.rev.status.applied"), tone: "success" },
  failed: { label: t("admin.rev.status.failed"), tone: "danger" },
};

/** `ck_payroll_runs__kind` (022 §1) — why the run exists. */
export const RUN_KIND_LABELS: Readonly<Record<string, string>> = {
  regular: t("admin.wreg.kind.regular"),
  off_cycle: t("admin.wreg.kind.off_cycle"),
  arrears: t("admin.wreg.kind.arrears"),
  bonus: t("admin.wreg.kind.bonus"),
  full_and_final: t("admin.wreg.kind.full_and_final"),
  correction: t("admin.wreg.kind.correction"),
};

export function runKindLabel(kind: string): string {
  return RUN_KIND_LABELS[kind] ?? kind;
}

/** `ck_esr__kind` (021). The labels the employee's own salary screen uses. */
export const REVISION_KIND_LABELS: Readonly<Record<string, string>> = {
  initial: t("pay.revisionKind.initial"),
  annual_increment: t("pay.revisionKind.annualIncrement"),
  promotion: t("pay.revisionKind.promotion"),
  market_correction: t("pay.revisionKind.marketCorrection"),
  role_change: t("pay.revisionKind.roleChange"),
  confirmation: t("pay.revisionKind.confirmation"),
  statutory_revision: t("pay.revisionKind.statutoryRevision"),
  correction: t("pay.revisionKind.correction"),
  demotion: t("pay.revisionKind.demotion"),
};

export function revisionKindLabel(kind: string): string {
  return REVISION_KIND_LABELS[kind] ?? kind;
}

/**
 * `ck_payslips__payment_status` (022 §3). The labels are the SAME catalogue
 * strings the employee's payslip list shows, so "In payment batch" means one
 * thing across the product.
 */
export const PAYMENT_STATUS_CHIP: Readonly<Record<PayslipPaymentStatus, StatusChipEntry>> = {
  pending: { label: t("pay.status.pending"), tone: "warn" },
  in_batch: { label: t("pay.status.inBatch"), tone: "info" },
  paid: { label: t("pay.status.paid"), tone: "success" },
  failed: { label: t("pay.status.failed"), tone: "danger" },
  held: { label: t("pay.status.held"), tone: "warn" },
  reversed: { label: t("pay.status.reversed"), tone: "danger" },
};

// -----------------------------------------------------------------------------
// Components + structures (`/admin/payroll/components`, `…/structures`)
// -----------------------------------------------------------------------------

export function useSalaryComponents(
  includeInactive: boolean,
): UseQueryResult<SalaryComponent[], Error> {
  return useQuery({
    queryKey: [...qk.admin.salaryComponents(), { includeInactive }],
    queryFn: ({ signal }) => fetchSalaryComponents({ includeInactive }, signal),
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

export function useSalaryStructures(
  includeInactive: boolean,
): UseQueryResult<SalaryStructure[], Error> {
  return useQuery({
    queryKey: ["admin", "payroll", "structures", { includeInactive }],
    queryFn: ({ signal }) => fetchSalaryStructures({ includeInactive }, signal),
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

/** Lines of the selected structure. Disabled until one is chosen. */
export function useStructureLines(
  structureId: string | null,
): UseQueryResult<StructureLine[], Error> {
  return useQuery({
    queryKey: ["admin", "payroll", "structures", "lines", structureId ?? "none"],
    queryFn: ({ signal }) => fetchStructureLines(structureId ?? "", signal),
    enabled: structureId !== null && structureId !== "",
    retry: shouldRetryQuery,
  });
}

/** id → component, for resolving structure lines and variance components. */
export function useComponentMap(
  components: readonly SalaryComponent[] | undefined,
): ReadonlyMap<string, SalaryComponent> {
  return useMemo(() => {
    const map = new Map<string, SalaryComponent>();
    for (const component of components ?? []) map.set(component.id, component);
    return map;
  }, [components]);
}

// -----------------------------------------------------------------------------
// Revisions register (`/admin/payroll/revisions`)
// -----------------------------------------------------------------------------

type InfinitePages<T> = UseInfiniteQueryResult<
  { pages: Page<T>[]; pageParams: unknown[] },
  Error
>;

/** Flatten loaded keyset pages into the series a grid renders. */
export function flattenPages<T>(data: { pages: Page<T>[] } | undefined): readonly T[] {
  if (data === undefined) return [];
  const out: T[] = [];
  for (const page of data.pages) out.push(...page.rows);
  return out;
}

/** Query keys must be plain, comparable data — readonly arrays are copied. */
function revisionKey(f: RevisionRegisterFilters): Record<string, unknown> {
  return {
    employeeIds: [...(f.employeeIds ?? [])].sort(),
    statuses: [...(f.statuses ?? [])].sort(),
    from: f.from ?? "",
    to: f.to ?? "",
  };
}

export function useRevisionRegister(f: RevisionRegisterFilters): InfinitePages<RevisionRow> {
  return useInfiniteQuery({
    initialPageParam: null as Cursor | null,
    queryKey: qk.admin.salaryRevisions({ ...revisionKey(f), register: true }),
    queryFn: ({ pageParam, signal }) =>
      fetchSalaryRevisions(f, REGISTER_PAGE_SIZE, pageParam, signal),
    getNextPageParam: (last) => last.nextCursor,
    retry: shouldRetryQuery,
  });
}

export function useRevisionCount(f: RevisionRegisterFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.salaryRevisions({ ...revisionKey(f), count: true }),
    queryFn: ({ signal }) => countSalaryRevisions(f, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Payslip register (`/admin/payroll/payslips`)
// -----------------------------------------------------------------------------

function payslipKey(f: PayslipRegisterFilters): Record<string, unknown> {
  return {
    payPeriodId: f.payPeriodId ?? "",
    runId: f.runId ?? "",
    employeeId: f.employeeId ?? "",
    paymentStatuses: [...(f.paymentStatuses ?? [])].sort(),
  };
}

export function usePayslipRegister(f: PayslipRegisterFilters): InfinitePages<PayslipHeader> {
  return useInfiniteQuery({
    initialPageParam: null as Cursor | null,
    queryKey: qk.admin.payslips({ ...payslipKey(f), register: true }),
    queryFn: ({ pageParam, signal }) =>
      fetchPayslipRegister(f, REGISTER_PAGE_SIZE, pageParam, signal),
    getNextPageParam: (last) => last.nextCursor,
    retry: shouldRetryQuery,
  });
}

export function usePayslipCount(f: PayslipRegisterFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.payslips({ ...payslipKey(f), count: true }),
    queryFn: ({ signal }) => countPayslipRegister(f, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Wage register (`/admin/payroll/register`)
// -----------------------------------------------------------------------------

/** The runs of one pay period — their totals ARE the register's totals. */
export function usePeriodRuns(payPeriodId: string | null): UseQueryResult<PayrollRun[], Error> {
  return useQuery({
    queryKey: qk.admin.payrollRuns({ payPeriodId: payPeriodId ?? "none", scope: "period" }),
    queryFn: async ({ signal }) => {
      const page = await fetchPayrollRuns(
        { payPeriodIds: [payPeriodId ?? ""] },
        50,
        null,
        signal,
      );
      return page.rows;
    },
    enabled: payPeriodId !== null && payPeriodId !== "",
    retry: shouldRetryQuery,
  });
}

/** Every payslip of the period, register-ordered and capped (the page says so). */
export function usePeriodPayslips(
  payPeriodId: string | null,
): UseQueryResult<PayslipHeader[], Error> {
  return useQuery({
    queryKey: qk.admin.payslips({ payPeriodId: payPeriodId ?? "none", scope: "register" }),
    queryFn: ({ signal }) => fetchPeriodPayslips(payPeriodId ?? "", signal),
    enabled: payPeriodId !== null && payPeriodId !== "",
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Variance report (`/admin/payroll/variance`)
// -----------------------------------------------------------------------------

export function useVarianceCount(
  runId: string | null,
  grain: "net_pay" | "component",
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: [...qk.admin.payrollVariance(runId ?? "none"), grain, "count"],
    queryFn: ({ signal }) => countVarianceRows(runId ?? "", grain, signal),
    enabled: runId !== null && runId !== "",
    retry: shouldRetryQuery,
  });
}

/** id → run, so registers can print a run number instead of a uuid. */
export function useRunMap(
  runs: readonly PayrollRun[] | undefined,
): ReadonlyMap<string, PayrollRun> {
  return useMemo(() => {
    const map = new Map<string, PayrollRun>();
    for (const run of runs ?? []) map.set(run.id, run);
    return map;
  }, [runs]);
}
