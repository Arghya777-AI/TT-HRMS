/**
 * usePeopleLifecycle — the data layer behind the five §2 lifecycle screens:
 * the stage board, onboarding/probation, transfers & promotions, exits &
 * clearance, and one employee's attendance month.
 *
 * Four rules this file exists to keep:
 *
 *  1. EVERY FIGURE IS A SERVER COUNT OVER THE LIST'S OWN PREDICATE. Each stage
 *     tile is a `count=exact` built from the SAME `LifecycleFilters` object the
 *     register read uses (`lifecycle.api.ts` owns both). `rows.length` is never a
 *     total: the registers are capped at 200 rows, so counting loaded rows would
 *     make a tile depend on the cap — the `7 vs 8` defect (DR-29).
 *  2. NOTHING IS DERIVED. `confirmation_due_date` is a GENERATED column,
 *     `employment_status` is the projection of the event stream, and the
 *     attendance month's 14 figures come from `f_attendance_period_summary`.
 *     This file moves rows.
 *  3. THE MOVEMENT WRITE IS THE EMPLOYEE MASTER'S OWN AUDITED UPDATE. Recording
 *     a transfer or a promotion is `updateEmployee` on department / section /
 *     designation / grade / manager, which audits one row per changed field with
 *     the typed reason. It does NOT append a `transferred` event: the deployed
 *     trigger projects events ONTO employees, never the reverse, and no RPC
 *     records the pairing atomically. The screen states that instead of pretending.
 *  4. LABELS ARE JOINED, NOT INVENTED. `employee_lifecycle_events` carries
 *     `employee_id` and jsonb value bags; names come from `useEmployeeLabels` and
 *     the org masters, and an id that resolves to nothing renders as a dash.
 */
import { useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { istMonthRange } from "@/lib/datetime";
import {
  useAuditedMutation,
  type AuditedMutationResult,
} from "@/shared/hooks/useAuditedMutation";
import {
  fetchEmployeePeriodSummary,
  type PeriodSummary,
} from "../api/attendance.api";
import {
  fetchCurrentSalary,
  fetchSalaryRevisions,
  updateEmployee,
  type AdminEmployee,
  type CurrentSalaryLine,
  type EmploymentStatus,
  type SalaryRevision,
  type UpdateEmployeeInput,
} from "../api/employees.api";
import type { ComplianceRow } from "../api/documents.api";
import { fetchCustody, type CustodyRow } from "../api/assets.api";
import {
  LIFECYCLE_LIST_LIMIT,
  countLifecycle,
  countLifecycleEvents,
  fetchLifecycleEvents,
  fetchLifecycleRegister,
  fetchOnboardingChecklist,
  type LifecycleEmployee,
  type LifecycleEvent,
  type LifecycleEventFilters,
  type LifecycleFilters,
  type LifecycleOrder,
} from "../api/lifecycle.api";

// -----------------------------------------------------------------------------
// Query keys — plain, comparable data (readonly arrays are flattened and sorted)
// -----------------------------------------------------------------------------

function registerKey(f: LifecycleFilters, order: string, limit: number): Record<string, unknown> {
  return {
    register: true,
    statuses: [...(f.statuses ?? [])].sort(),
    departmentIds: [...(f.departmentIds ?? [])].sort(),
    locationIds: [...(f.locationIds ?? [])].sort(),
    nameLike: f.nameLike ?? "",
    dueOnOrBefore: f.dueOnOrBefore ?? "",
    dueOnOrAfter: f.dueOnOrAfter ?? "",
    hasConfirmationDue: f.hasConfirmationDue === true,
    lastWorkingDayFrom: f.lastWorkingDayFrom ?? "",
    lastWorkingDayTo: f.lastWorkingDayTo ?? "",
    exitTypes: [...(f.exitTypes ?? [])].sort(),
    settlementPending: f.settlementPending ?? null,
    interviewPending: f.interviewPending ?? null,
    rehireEligible: f.rehireEligible ?? null,
    rehireDecided: f.rehireDecided ?? null,
    order,
    limit,
  };
}

function eventKey(f: LifecycleEventFilters, limit: number): Record<string, unknown> {
  return {
    events: true,
    eventTypes: [...(f.eventTypes ?? [])].sort(),
    employeeIds: [...(f.employeeIds ?? [])].sort(),
    from: f.from ?? "",
    to: f.to ?? "",
    includeReversed: f.includeReversed === true,
    limit,
  };
}

// -----------------------------------------------------------------------------
// 1. Registers + their server counts
// -----------------------------------------------------------------------------

/**
 * One register page, capped. Kept a SEPARATE query from its count so a failed
 * count degrades to "—" in the header while the list still renders — the partial
 * state, not a dead screen.
 */
export function useLifecycleRegister(
  filters: LifecycleFilters,
  order: LifecycleOrder,
  limit = LIFECYCLE_LIST_LIMIT,
): UseQueryResult<LifecycleEmployee[], Error> {
  return useQuery({
    queryKey: qk.admin.employees(registerKey(filters, order, limit)),
    queryFn: ({ signal }) => fetchLifecycleRegister(filters, order, limit, signal),
    retry: shouldRetryQuery,
  });
}

/** How many employees match, counted by Postgres over the register's predicate. */
export function useLifecycleCount(filters: LifecycleFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.employees({ ...registerKey(filters, "count", 0), count: true }),
    queryFn: ({ signal }) => countLifecycle(filters, signal),
    retry: shouldRetryQuery,
  });
}

/** One stage's slice of the board, as the database counts it. */
export interface StageCount {
  readonly status: EmploymentStatus;
  readonly count: number | undefined;
  readonly error: Error | null;
  readonly isPending: boolean;
}

/**
 * The per-stage breakdown of the lifecycle board: one `count=exact` per
 * employment status, each carrying whatever department/location filter is in
 * force — i.e. exactly the predicate the tile drills into.
 *
 * `useQueries` rather than a list of `useQuery` calls because the vocabulary is
 * the deployed enum (11 values) and a hook cannot be called in a loop; this keeps
 * the board exhaustive instead of a curated subset that would silently hide a
 * stage nobody thought of.
 */
export function useLifecycleStageCounts(
  base: LifecycleFilters,
  statuses: readonly EmploymentStatus[],
): StageCount[] {
  const results = useQueries({
    queries: statuses.map((status) => {
      const scoped: LifecycleFilters = { ...base, statuses: [status] };
      return {
        queryKey: qk.admin.employees({ ...registerKey(scoped, "count", 0), count: true }),
        queryFn: ({ signal }: { signal: AbortSignal }) => countLifecycle(scoped, signal),
        retry: shouldRetryQuery,
      };
    }),
  });

  const out: StageCount[] = [];
  results.forEach((result, index) => {
    const status = statuses[index];
    if (status === undefined) return;
    out.push({
      status,
      count: result.data,
      error: result.error,
      isPending: result.isPending,
    });
  });
  return out;
}

// -----------------------------------------------------------------------------
// 2. The append-only event stream
// -----------------------------------------------------------------------------

export function useLifecycleEvents(
  filters: LifecycleEventFilters,
  limit = LIFECYCLE_LIST_LIMIT,
): UseQueryResult<LifecycleEvent[], Error> {
  return useQuery({
    queryKey: qk.admin.employees(eventKey(filters, limit)),
    queryFn: ({ signal }) => fetchLifecycleEvents(filters, limit, signal),
    retry: shouldRetryQuery,
  });
}

export function useLifecycleEventCount(
  filters: LifecycleEventFilters,
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.employees({ ...eventKey(filters, 0), count: true }),
    queryFn: ({ signal }) => countLifecycleEvents(filters, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 2b. One joiner's document checklist — the only deployed onboarding checklist
// -----------------------------------------------------------------------------

/**
 * The required-document rows for ONE employee. Empty is meaningful here: a
 * `pre_joining` joiner is excluded by `v_document_compliance`'s own WHERE clause,
 * so the panel says that instead of showing a reassuring "all clear".
 */
export function useOnboardingChecklist(
  employeeId: string | null,
): UseQueryResult<ComplianceRow[], Error> {
  return useQuery({
    queryKey: qk.admin.employeeDocuments(employeeId ?? "none"),
    queryFn: ({ signal }) => fetchOnboardingChecklist(employeeId ?? "", signal),
    enabled: employeeId !== null && employeeId !== "",
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 2c. One leaver's open asset custody — the only deployed "clearance item"
// -----------------------------------------------------------------------------

/**
 * The assets ONE employee still holds, from `v_asset_custody`.
 *
 * There is no clearance-checklist table in the deployed schema: `clearance`
 * appears in the migrations exactly twice, both times as the `EXIT_CLEARANCE`
 * DOCUMENT TYPE, and no view aggregates exit dues. What the database does know is
 * which allocations are still open (`v_asset_custody` — allocated /
 * acknowledged / return_requested, with the server's own `days_in_custody` and
 * `is_return_overdue`). That is the recoverable-property half of a clearance, and
 * the exits screen shows it as exactly that much and no more.
 */
export function useExitCustody(employeeId: string | null): UseQueryResult<CustodyRow[], Error> {
  return useQuery({
    queryKey: qk.assets.list({ custody: true, employeeId: employeeId ?? "none" }),
    queryFn: ({ signal }) => fetchCustody({ employeeIds: [employeeId ?? ""] }, signal),
    enabled: employeeId !== null && employeeId !== "",
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 3. Audited writes on the employee master
// -----------------------------------------------------------------------------

/**
 * Save a movement (department / section / designation / grade / manager) or a
 * settlement field, as an audited UPDATE of `employees`.
 *
 * The reason is typed by the human every time — `updateEmployee` refuses a
 * reasonless write before it leaves the browser, and `employees` is in
 * `audit.reason_required_tables`, so the database refuses it too (SQLSTATE
 * 22023). The floor is raised to 15 characters because a movement and a
 * full-and-final are the kind of change someone reads back a year later.
 */
export function useLifecycleEmployeeUpdate(
  code: string,
): AuditedMutationResult<AdminEmployee, UpdateEmployeeInput> {
  return useAuditedMutation<AdminEmployee, UpdateEmployeeInput>({
    mutationFn: (input, reason) => updateEmployee(input, reason),
    invalidate: [qk.admin.employeesAll(), qk.admin.employee(code)],
    minReasonLength: 15,
  });
}

// -----------------------------------------------------------------------------
// 3b. One employee's compensation — read-only, integer paise, server totals
// -----------------------------------------------------------------------------

/**
 * The CURRENT revision's component lines, from `v_employee_current_salary`.
 *
 * The view is a join, so every line repeats the revision's header totals
 * (`monthly_gross_paise`, `monthly_ctc_paise`, `annual_ctc_paise`, the three CTC
 * buckets). A caller reads those off ONE row and never sums the lines: the lines
 * and the totals come from different levels of the same server calculation, and
 * adding them up in the browser is how a payslip and a structure start
 * disagreeing by a rupee.
 *
 * Empty is meaningful: `v_employee_current_salary` is RLS-protected, so no rows
 * means either no approved revision exists or compensation is not in the caller's
 * scope — indistinguishable at the wire, and the screen says exactly that.
 */
export function useEmployeeCurrentSalary(
  employeeId: string | null,
): UseQueryResult<CurrentSalaryLine[], Error> {
  return useQuery({
    queryKey: qk.admin.employeeSalary(employeeId ?? "none"),
    queryFn: ({ signal }) => fetchCurrentSalary(employeeId ?? "", signal),
    enabled: employeeId !== null && employeeId !== "",
    retry: shouldRetryQuery,
  });
}

/**
 * Every revision on one employee, newest effective date first, from
 * `v_salary_revisions` — including `increment_amount_paise`, `increment_pct` and
 * `months_since_previous`, all computed by the view. The screen renders those
 * columns; it never subtracts two CTCs to find a raise.
 */
export function useEmployeeSalaryRevisions(
  employeeId: string | null,
): UseQueryResult<SalaryRevision[], Error> {
  return useQuery({
    queryKey: qk.admin.employeeRevisions(employeeId ?? "none"),
    queryFn: ({ signal }) => fetchSalaryRevisions(employeeId ?? "", signal),
    enabled: employeeId !== null && employeeId !== "",
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 4. One employee's attendance month
// -----------------------------------------------------------------------------

/**
 * The 14-figure strip for one employee over one IST month, straight from
 * `f_attendance_period_summary` — the same function the employee's own month and
 * the Command Centre read, so the numbers cannot differ by screen.
 *
 * `null` (rather than an error) when the function returns no row: for an
 * RLS-protected read "no such employee" and "not in your admin scope" are
 * indistinguishable at the wire, and the page says so instead of guessing.
 */
export function useEmployeePeriodSummary(
  employeeId: string | null,
  from: string,
  to: string,
): UseQueryResult<PeriodSummary | null, Error> {
  return useQuery({
    queryKey: qk.admin.attendanceSummary(from, to, employeeId ?? "none"),
    queryFn: ({ signal }) => fetchEmployeePeriodSummary(employeeId ?? "", from, to, signal),
    enabled: employeeId !== null && employeeId !== "",
    retry: shouldRetryQuery,
  });
}

/**
 * The same strip for one IST month.
 *
 * Kept as a thin wrapper rather than the primary shape: `f_attendance_period_summary`
 * has ALWAYS taken an arbitrary (employee, from, to) — the month was only how this
 * hook happened to be parameterised, and that accident was what stopped
 * `/admin/people/:code/attendance` from honouring the shared day/week/year period.
 * The function was never the constraint.
 */
export function useEmployeeMonthSummary(
  employeeId: string | null,
  month: string,
): UseQueryResult<PeriodSummary | null, Error> {
  const range = istMonthRange(month);
  return useEmployeePeriodSummary(employeeId, range.from, range.to);
}
