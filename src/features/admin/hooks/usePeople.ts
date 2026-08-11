/**
 * usePeople — the data layer behind /admin/people and the Employee 360.
 *
 * Two rules this file exists to keep:
 *
 *  1. THE TOTAL AND THE ROWS COME FROM THE SAME PREDICATE. `useDirectoryCount`
 *     and `useEmployeeDirectory` are handed the identical `DirectoryFilters`
 *     object, and `employees.api.ts` builds both requests from one
 *     `directoryFilters(f)` array. Counting `rows.length` instead would make the
 *     header total depend on how far the admin has scrolled (DR-29).
 *  2. KEYSET PAGING, NOT OFFSET. `v_admin_employee` is written while an admin
 *     scrolls it — a joiner is added, someone is archived — and OFFSET paging
 *     over a shifting set repeats and skips rows. `paginate()` carries a cursor
 *     on (employee_code, id).
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
import {
  useAuditedMutation,
  type AuditedMutationResult,
} from "@/shared/hooks/useAuditedMutation";
import type { FieldOption } from "../masters/fields";
import type { PeopleRefs } from "../people/fields";
import { useEmployeeRefOptions, usePayPeriods, useRefOptions, type RefOption } from "./useMasters";
import { fetchEmployeeAuditTrail, type EmployeeAuditRow } from "../api/audit.api";
import {
  countEmployeeDirectory,
  fetchAdminEmployeeByCode,
  fetchBankAccountsMasked,
  fetchEmployeeDirectory,
  type DirectorySort,
  fetchStatutoryMasked,
  revealBankAccounts,
  revealStatutory,
  updateEmployee,
  type AdminEmployee,
  type BankMasked,
  type DirectoryFilters,
  type DirectoryRow,
  type RevealedBank,
  type RevealedStatutory,
  type StatutoryMasked,
  type UpdateEmployeeInput,
} from "../api/employees.api";

export const DIRECTORY_PAGE_SIZE = 50;

export type DirectoryInfinite = UseInfiniteQueryResult<
  { pages: Page<DirectoryRow>[]; pageParams: unknown[] },
  Error
>;

/** Flatten loaded pages into the series the grid renders. */
export function flattenDirectory(
  data: { pages: Page<DirectoryRow>[] } | undefined,
): readonly DirectoryRow[] {
  if (data === undefined) return [];
  const out: DirectoryRow[] = [];
  for (const page of data.pages) out.push(...page.rows);
  return out;
}

/**
 * Query keys must be plain, comparable data. `DirectoryFilters` holds readonly
 * arrays, so it is flattened into a literal — two filter objects that mean the
 * same thing then share a cache entry instead of missing it.
 */
function directoryKey(f: DirectoryFilters, pageSize: number): Record<string, unknown> {
  return {
    statuses: [...(f.statuses ?? [])].sort(),
    employmentTypes: [...(f.employmentTypes ?? [])].sort(),
    departmentIds: [...(f.departmentIds ?? [])].sort(),
    locationIds: [...(f.locationIds ?? [])].sort(),
    designationIds: [...(f.designationIds ?? [])].sort(),
    nameLike: f.nameLike ?? "",
    employeeCode: f.employeeCode ?? "",
    mobileLike: f.mobileLike ?? "",
    archived: f.archived === true,
    pageSize,
  };
}

export function useEmployeeDirectory(
  filters: DirectoryFilters,
  pageSize = DIRECTORY_PAGE_SIZE,
  sort: DirectorySort = "name",
): DirectoryInfinite {
  return useInfiniteQuery({
    initialPageParam: null as Cursor | null,
    retry: shouldRetryQuery,
    /* The sort is part of the key: changing it changes the ORDER of every page,
       so the cached pages of the old sort are not pages of the new one. */
    queryKey: qk.admin.employees({ ...directoryKey(filters, pageSize), sort }),
    queryFn: ({ pageParam, signal }) =>
      fetchEmployeeDirectory(filters, pageSize, pageParam, sort, signal),
    getNextPageParam: (last) => last.nextCursor,
  });
}

/**
 * How many employees match, counted by Postgres. Kept a SEPARATE query from the
 * list so a failed count degrades to "—" on the header while the grid still
 * renders — the partial state, not a dead screen.
 */
export function useDirectoryCount(filters: DirectoryFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.employees({ ...directoryKey(filters, 0), count: true }),
    queryFn: ({ signal }) => countEmployeeDirectory(filters, signal),
    retry: shouldRetryQuery,
  });
}

/**
 * Every picker list the Add Employee wizard and the 360 need, in one hook.
 *
 * Each list is an independent cached query (they are the same queries the twelve
 * lookup-master screens already use, so they are usually warm). A list that
 * fails resolves to `[]` rather than breaking the form: an admin can still fill
 * in the fields that did load, and a required select with no options shows its
 * own validation error rather than a crashed page.
 */
export function usePeopleRefs(): PeopleRefs {
  const departments = useRefOptions("departments");
  const sections = useRefOptions("sections");
  const designations = useRefOptions("designations");
  const grades = useRefOptions("grades");
  const locations = useRefOptions("locations");
  const costCentres = useRefOptions("costCentres");
  const shifts = useRefOptions("shifts");
  const weeklyOffRules = useRefOptions("weeklyOffRules");
  const holidayCalendars = useRefOptions("holidayCalendars");
  const managers = useEmployeeRefOptions();
  const payPeriods = usePayPeriods();

  return useMemo<PeopleRefs>(() => {
    const opts = (rows: readonly RefOption[] | undefined): FieldOption[] =>
      (rows ?? []).map((r) => ({ value: r.id, label: r.name }));
    return {
      departments: opts(departments.data),
      sections: opts(sections.data),
      designations: opts(designations.data),
      grades: opts(grades.data),
      locations: opts(locations.data),
      costCentres: opts(costCentres.data),
      shifts: opts(shifts.data),
      weeklyOffRules: opts(weeklyOffRules.data),
      holidayCalendars: opts(holidayCalendars.data),
      // No attendance-policy master hook exists yet; an empty list renders an
      // empty select rather than a wrong one. Reported, not faked.
      attendancePolicies: [],
      payPeriods: (payPeriods.data ?? []).map((p) => ({ value: p.id, label: p.name })),
      managers: opts(managers.data),
      // The 360's Payment tab supplies this per employee; the wizard has no
      // accounts to choose from because the person does not exist yet.
      bankAccounts: [],
    };
  }, [
    departments.data,
    sections.data,
    designations.data,
    grades.data,
    locations.data,
    costCentres.data,
    shifts.data,
    weeklyOffRules.data,
    holidayCalendars.data,
    payPeriods.data,
    managers.data,
  ]);
}

/** One employee, by the code in the URL. The 360's primary read. */
export function useAdminEmployee(code: string): UseQueryResult<AdminEmployee, Error> {
  return useQuery({
    queryKey: qk.admin.employee(code),
    queryFn: ({ signal }) => fetchAdminEmployeeByCode(code, signal),
    enabled: code !== "",
    retry: shouldRetryQuery,
  });
}

/**
 * Save an edit to the employee master.
 *
 * `expectedUpdatedAt` is the optimistic lock: the UPDATE also filters on
 * `updated_at`, so if someone else saved while this form was open the write
 * matches zero rows and reports `not_found` instead of silently overwriting
 * their change. That is the difference between a form and a race.
 */
export function useUpdateEmployee(
  code: string,
): AuditedMutationResult<AdminEmployee, UpdateEmployeeInput> {
  return useAuditedMutation<AdminEmployee, UpdateEmployeeInput>({
    mutationFn: (input, reason) => updateEmployee(input, reason),
    invalidate: [qk.admin.employeesAll(), qk.admin.employee(code)],
  });
}

/**
 * The audited reveal of PAN / Aadhaar / UAN / ESIC.
 *
 * This is a READ that behaves like a write: `reveal_employee_statutory` records
 * a per-subject row in the data-access log with the caller, the reason and the
 * timestamp, which is why it is a mutation hook behind an explicit button rather
 * than part of the page's normal load. The reason floor is higher than for an
 * ordinary edit (the API enforces it, not the UI).
 */
export function useRevealStatutory(
  employeeId: string | null,
): AuditedMutationResult<RevealedStatutory, void> {
  return useAuditedMutation<RevealedStatutory, void>({
    mutationFn: (_input, reason) => revealStatutory(employeeId ?? "", reason),
    invalidate: [qk.admin.employeeStatutory(employeeId ?? "none")],
    minReasonLength: 15,
  });
}

/** Same posture as the statutory reveal, for bank account numbers. */
export function useRevealBank(
  employeeId: string | null,
): AuditedMutationResult<RevealedBank[], void> {
  return useAuditedMutation<RevealedBank[], void>({
    mutationFn: (_input, reason) => revealBankAccounts(employeeId ?? "", reason),
    invalidate: [qk.admin.employeeBank(employeeId ?? "none")],
    minReasonLength: 15,
  });
}

export const EMPLOYEE_AUDIT_PAGE_SIZE = 50;

export type EmployeeAuditFilters = {
  from?: string;
  to?: string;
  fieldName?: string;
  onlyWithReason?: boolean;
};

/**
 * One employee's complete field-level history, newest first, keyset-paginated
 * because `audit_log` is append-only and is being written while it is read.
 */
export function useEmployeeAudit(
  employeeId: string | null,
  filters: EmployeeAuditFilters,
  pageSize = EMPLOYEE_AUDIT_PAGE_SIZE,
): UseInfiniteQueryResult<{ pages: Page<EmployeeAuditRow>[]; pageParams: unknown[] }, Error> {
  return useInfiniteQuery({
    initialPageParam: null as Cursor | null,
    retry: shouldRetryQuery,
    queryKey: qk.admin.employeeAudit(employeeId ?? "none", {
      from: filters.from ?? "",
      to: filters.to ?? "",
      fieldName: filters.fieldName ?? "",
      onlyWithReason: filters.onlyWithReason === true,
      pageSize,
    }),
    queryFn: ({ pageParam, signal }) =>
      fetchEmployeeAuditTrail(employeeId ?? "", filters, pageSize, pageParam, signal),
    getNextPageParam: (last) => last.nextCursor,
    enabled: employeeId !== null && employeeId !== "",
  });
}

/** Flatten audit pages into the series the list renders. */
export function flattenAudit(
  data: { pages: Page<EmployeeAuditRow>[] } | undefined,
): readonly EmployeeAuditRow[] {
  if (data === undefined) return [];
  const out: EmployeeAuditRow[] = [];
  for (const page of data.pages) out.push(...page.rows);
  return out;
}

/**
 * PAN / Aadhaar / UAN / ESIC, already masked BY THE VIEW. Reading this is not a
 * reveal and writes no per-subject audit row; `revealStatutory` is the audited
 * action and lives behind an explicit button (§4.6).
 */
export function useStatutoryMasked(
  employeeId: string | null,
): UseQueryResult<StatutoryMasked | null, Error> {
  return useQuery({
    queryKey: qk.admin.employeeStatutory(employeeId ?? "none"),
    queryFn: ({ signal }) => fetchStatutoryMasked(employeeId ?? "", signal),
    enabled: employeeId !== null && employeeId !== "",
    retry: shouldRetryQuery,
  });
}

/** Bank accounts, masked by the view. Same reveal posture as statutory. */
export function useBankMasked(
  employeeId: string | null,
): UseQueryResult<BankMasked[], Error> {
  return useQuery({
    queryKey: qk.admin.employeeBank(employeeId ?? "none"),
    queryFn: ({ signal }) => fetchBankAccountsMasked(employeeId ?? "", signal),
    enabled: employeeId !== null && employeeId !== "",
    retry: shouldRetryQuery,
  });
}
