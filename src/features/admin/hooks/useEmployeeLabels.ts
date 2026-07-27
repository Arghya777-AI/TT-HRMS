/**
 * useEmployeeLabels — one shared read of "who is who", so seven admin screens do
 * not each fetch the directory.
 *
 * Why it is needed: `v_leave_balance_current`, `comp_off_ledger`,
 * `v_comp_off_balance`, `leave_requests`, `v_salary_revisions` and
 * `payroll_run_employees` all carry `employee_id` and NO name — the person's
 * name lives on `employees`/`v_admin_employee`. Resolving an id to a label is a
 * join, not a computation: nothing here derives or aggregates a business figure.
 *
 * The map is keyed by `employees.id` and ordered by display name, so
 * `[...labels.values()]` is also the picker's option order.
 */
import { useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { fetchEmployeeOptions, type DirectoryRow } from "../api/employees.api";
import type { SelectOption } from "../components/Field";

export interface EmployeeLabel {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly department: string | null;
  readonly designation: string | null;
}

function toLabel(row: DirectoryRow): EmployeeLabel {
  return {
    id: row.id,
    code: row.employee_code,
    name: row.display_name,
    department: row.department_name,
    designation: row.designation_name,
  };
}

export type EmployeeLabelMap = ReadonlyMap<string, EmployeeLabel>;

/** Every employee in admin scope, keyed by id. Includes exits: history needs them. */
export function useEmployeeLabels(): UseQueryResult<EmployeeLabelMap, Error> {
  return useQuery({
    queryKey: qk.admin.employees({ scope: "labels" }),
    queryFn: async ({ signal }) => {
      const rows = await fetchEmployeeOptions({}, 500, signal);
      const map = new Map<string, EmployeeLabel>();
      for (const row of rows) map.set(row.id, toLabel(row));
      return map as EmployeeLabelMap;
    },
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

/** `<SelectField>` options for an employee picker, name-ordered with the code. */
export function useEmployeeOptions(labels: EmployeeLabelMap | undefined): SelectOption[] {
  return useMemo(() => {
    if (labels === undefined) return [];
    return [...labels.values()].map((label) => ({
      value: label.id,
      label: `${label.name} · ${label.code}`,
    }));
  }, [labels]);
}
