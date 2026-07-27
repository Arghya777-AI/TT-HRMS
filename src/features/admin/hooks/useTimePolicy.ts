/**
 * useTimePolicy.ts — TanStack hooks for Policy Assignments (§6.6) and the
 * "Why this policy?" resolver (§6.7).
 *
 * Two decisions worth stating:
 *
 *  1. EVERY KEY LIVES UNDER `qk.admin.orgList(...)`, i.e. the
 *     `["admin","org",…]` prefix the time-policy masters already use. So creating
 *     or end-dating a binding invalidates `qk.admin.orgAll()` and BOTH screens
 *     refresh — the resolver cannot keep answering with a binding the admin just
 *     retired, which is exactly the class of disagreement these two screens exist
 *     to expose.
 *  2. THE FAN-OUT READS ARE ONE QUERY EACH. `resolve_policy` has to be called
 *     once per kind, and the shift trace needs four different rows; both are done
 *     with `Promise.all` INSIDE a single `queryFn` rather than with a hook per
 *     call, because a hook per kind is a hook inside a loop the moment the kind
 *     list changes.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { SENSITIVE_REASON_LENGTH, shouldRetryQuery } from "@/shared/api/query";
import { useAuditedMutation, type AuditedMutationResult } from "@/shared/hooks/useAuditedMutation";
import {
  fetchAdminEmployeeById,
  fetchEmployeeOptions,
  type AdminEmployee,
} from "../api/employees.api";
import {
  KIND_POLICY_TABLE,
  SCOPE_REF_TABLE,
  SHIFTS_TABLE,
  archivePolicyAssignment,
  assignmentKindValues,
  countPolicyAssignments,
  coversDate,
  endDatePolicyAssignment,
  fetchCompanyDefaultShift,
  fetchDesignationDefaultShift,
  fetchEmployeeRefsByIds,
  fetchHolidaysOnDate,
  fetchPayPeriodForDate,
  fetchPolicyAssignments,
  fetchPublishedRosterSlot,
  fetchRefsByIds,
  fetchShiftAssignments,
  fetchShiftDetail,
  insertPolicyAssignment,
  resolveIsWeeklyOff,
  resolvePolicyId,
  resolveShiftId,
  restorePolicyAssignment,
  type AssignmentCreateInput,
  type AssignmentEndDateInput,
  type AssignmentFilters,
  type AssignmentKind,
  type AssignmentScope,
  type DesignationShift,
  type EmployeeRef,
  type HolidayOnDate,
  type PayPeriodOnDate,
  type PolicyAssignment,
  type PolicyRef,
  type RosterSlotRef,
  type ShiftAssignment,
  type ShiftDetail,
} from "../api/time-policy.api";

/** Query keys have to be plain data; `AssignmentFilters` is an interface. */
function assignmentKey(f: AssignmentFilters) {
  return qk.admin.orgList("policyAssignments", {
    kinds: [...(f.kinds ?? [])].sort(),
    scopes: [...(f.scopes ?? [])].sort(),
    archived: f.archived === true,
    startedBy: f.startedBy ?? "",
  });
}

// -----------------------------------------------------------------------------
// 1. The binding register
// -----------------------------------------------------------------------------

export function usePolicyAssignments(
  filters: AssignmentFilters = {},
): UseQueryResult<PolicyAssignment[], Error> {
  return useQuery({
    queryKey: assignmentKey(filters),
    queryFn: ({ signal }) => fetchPolicyAssignments(filters, 500, signal),
    retry: shouldRetryQuery,
  });
}

/** The register's cardinality, from Postgres, over the grid's own filters. */
export function usePolicyAssignmentCount(
  filters: AssignmentFilters = {},
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: [...assignmentKey(filters), "count"],
    queryFn: ({ signal }) => countPolicyAssignments(filters, signal),
    retry: shouldRetryQuery,
  });
}

export interface AssignmentLabels {
  /** `policy_id` → the row it points at, in whichever table its kind owns. */
  readonly policies: ReadonlyMap<string, PolicyRef>;
  /** Scope target id → the org row it points at. */
  readonly scopes: ReadonlyMap<string, PolicyRef>;
  /** Scope target id → the employee, for `scope = 'employee'` bindings. */
  readonly employees: ReadonlyMap<string, EmployeeRef>;
}

/**
 * Resolve every id in the LOADED rows to a name, in one query.
 *
 * `policy_assignments.policy_id` has no foreign key (it is polymorphic per kind),
 * so a label is a lookup in the table that kind owns — six possible tables, seven
 * for the scope targets. Doing that as one `Promise.all` of `IN (…)` reads keeps
 * it to a handful of small requests and keeps the hook count fixed; a hook per
 * table would be a hook inside a loop.
 */
export function useAssignmentLabels(
  rows: readonly PolicyAssignment[],
): UseQueryResult<AssignmentLabels, Error> {
  // The key is the exact id set, so two different filter states that happen to
  // reference the same rows share one cache entry.
  const idKey = rows
    .map((row) => `${row.assignment_kind}:${row.policy_id}|${row.scope}:${targetOf(row) ?? ""}`)
    .sort()
    .join(",");

  return useQuery({
    queryKey: qk.admin.orgList("policyAssignmentLabels", { ids: idKey }),
    enabled: rows.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
    queryFn: async ({ signal }): Promise<AssignmentLabels> => {
      const policyIdsByTable = new Map<string, Set<string>>();
      const scopeIdsByTable = new Map<string, Set<string>>();
      const employeeIds = new Set<string>();

      for (const row of rows) {
        const kindTable = KIND_POLICY_TABLE[row.assignment_kind as AssignmentKind];
        if (kindTable !== undefined) {
          const set = policyIdsByTable.get(kindTable) ?? new Set<string>();
          set.add(row.policy_id);
          policyIdsByTable.set(kindTable, set);
        }
        const target = targetOf(row);
        if (target === null) continue;
        if (row.scope === "employee") {
          employeeIds.add(target);
          continue;
        }
        const scopeTable = SCOPE_REF_TABLE[row.scope as AssignmentScope];
        if (scopeTable !== undefined) {
          const set = scopeIdsByTable.get(scopeTable) ?? new Set<string>();
          set.add(target);
          scopeIdsByTable.set(scopeTable, set);
        }
      }

      const policyReads = [...policyIdsByTable].map(([table, ids]) =>
        fetchRefsByIds(table, [...ids], signal),
      );
      const scopeReads = [...scopeIdsByTable].map(([table, ids]) =>
        fetchRefsByIds(table, [...ids], signal),
      );
      const [policyMaps, scopeMaps, employees] = await Promise.all([
        Promise.all(policyReads),
        Promise.all(scopeReads),
        fetchEmployeeRefsByIds([...employeeIds], signal),
      ]);

      return {
        policies: mergeMaps(policyMaps),
        scopes: mergeMaps(scopeMaps),
        employees,
      };
    },
  });
}

/** The one target column `ck_pa__scope_target` filled in for this row. */
export function targetOf(row: PolicyAssignment): string | null {
  switch (row.scope) {
    case "employee":
      return row.employee_id;
    case "designation":
      return row.designation_id;
    case "grade":
      return row.grade_id;
    case "section":
      return row.section_id;
    case "department":
      return row.department_id;
    case "employment_type":
      return row.employment_type;
    case "location":
      return row.location_id;
    case "company":
      return row.company_id;
    default:
      return null;
  }
}

function mergeMaps(maps: readonly ReadonlyMap<string, PolicyRef>[]): ReadonlyMap<string, PolicyRef> {
  const out = new Map<string, PolicyRef>();
  for (const map of maps) for (const [id, ref] of map) out.set(id, ref);
  return out;
}

// -----------------------------------------------------------------------------
// 2. Writes — all three prompt for a reason, none of them deletes
// -----------------------------------------------------------------------------

/** Everything under the org prefix: the register, the labels and the resolver. */
const INVALIDATE_TIME_POLICY = [qk.admin.orgAll()] as const;

/**
 * Create a binding. No `defaultReason`: a new binding silently re-prices
 * attendance for everyone in scope, so a missed prompt must fail loudly rather
 * than invent a justification.
 */
export function useAssignmentCreate(
  onDone?: (row: PolicyAssignment) => void,
): AuditedMutationResult<PolicyAssignment, AssignmentCreateInput> {
  return useAuditedMutation<PolicyAssignment, AssignmentCreateInput>({
    mutationFn: (input, reason) => insertPolicyAssignment(input, reason),
    invalidate: INVALIDATE_TIME_POLICY,
    minReasonLength: SENSITIVE_REASON_LENGTH,
    ...(onDone ? { onSuccess: onDone } : {}),
  });
}

export function useAssignmentEndDate(
  onDone?: (row: PolicyAssignment) => void,
): AuditedMutationResult<PolicyAssignment, AssignmentEndDateInput> {
  return useAuditedMutation<PolicyAssignment, AssignmentEndDateInput>({
    mutationFn: (input, reason) => endDatePolicyAssignment(input, reason),
    invalidate: INVALIDATE_TIME_POLICY,
    minReasonLength: SENSITIVE_REASON_LENGTH,
    ...(onDone ? { onSuccess: onDone } : {}),
  });
}

export interface AssignmentIdInput {
  readonly id: string;
}

export function useAssignmentArchive(
  onDone?: () => void,
): AuditedMutationResult<void, AssignmentIdInput> {
  return useAuditedMutation<void, AssignmentIdInput>({
    mutationFn: (input, reason) => archivePolicyAssignment(input.id, reason),
    invalidate: INVALIDATE_TIME_POLICY,
    minReasonLength: SENSITIVE_REASON_LENGTH,
    ...(onDone ? { onSuccess: () => onDone() } : {}),
  });
}

export function useAssignmentRestore(
  onDone?: () => void,
): AuditedMutationResult<void, AssignmentIdInput> {
  return useAuditedMutation<void, AssignmentIdInput>({
    mutationFn: (input, reason) => restorePolicyAssignment(input.id, reason),
    invalidate: INVALIDATE_TIME_POLICY,
    minReasonLength: SENSITIVE_REASON_LENGTH,
    ...(onDone ? { onSuccess: () => onDone() } : {}),
  });
}

/**
 * Employees for a picker — the binding form's `scope = 'employee'` target, and the
 * resolver's "whose policy?" control.
 *
 * `enabled` matters: the assignment register itself resolves the employee names it
 * needs through `useAssignmentLabels` (only the ids on screen), so the whole
 * directory is read only when a form that needs the picker is actually open.
 */
export function useAssignmentEmployeeOptions(
  enabled: boolean,
): UseQueryResult<EmployeeRef[], Error> {
  return useQuery({
    queryKey: qk.admin.employees({ picker: "policy-assignment" }),
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
    queryFn: async ({ signal }): Promise<EmployeeRef[]> => {
      const rows = await fetchEmployeeOptions({}, 300, signal);
      return rows.map((row) => ({
        id: row.id,
        employee_code: row.employee_code,
        display_name: row.display_name,
      }));
    },
  });
}

// -----------------------------------------------------------------------------
// 3. The resolver — one employee, one date
// -----------------------------------------------------------------------------

/** The employee whose scope values the resolver is about. */
export function useResolverEmployee(
  employeeId: string | null,
): UseQueryResult<AdminEmployee | null, Error> {
  return useQuery({
    queryKey: qk.admin.employeeById(employeeId ?? "none"),
    queryFn: ({ signal }) => fetchAdminEmployeeById(employeeId ?? "", signal),
    enabled: employeeId !== null && employeeId !== "",
    retry: shouldRetryQuery,
  });
}

/** kind → the winning `policy_id`, straight from `resolve_policy`. */
export type ResolvedPolicyIds = Readonly<Record<AssignmentKind, string | null>>;

export interface ServerResolution {
  readonly policies: ResolvedPolicyIds;
  /** `resolve_shift_for_date` — the shift the engine will actually use. */
  readonly shiftId: string | null;
}

/**
 * ONE query, six `resolve_policy` calls plus `resolve_shift_for_date`. These are
 * the deployed functions — nothing about precedence is decided in the browser.
 */
export function useServerResolution(
  employeeId: string | null,
  isoDate: string,
): UseQueryResult<ServerResolution, Error> {
  return useQuery({
    queryKey: qk.admin.orgList("policyResolution", { employeeId: employeeId ?? "", isoDate }),
    enabled: employeeId !== null && employeeId !== "",
    retry: shouldRetryQuery,
    queryFn: async ({ signal }): Promise<ServerResolution> => {
      const id = employeeId ?? "";
      const [ids, shiftId] = await Promise.all([
        Promise.all(assignmentKindValues.map((kind) => resolvePolicyId(kind, id, isoDate, signal))),
        resolveShiftId(id, isoDate, signal),
      ]);
      const policies: Record<string, string | null> = {};
      assignmentKindValues.forEach((kind, index) => {
        policies[kind] = ids[index] ?? null;
      });
      return { policies: policies as ResolvedPolicyIds, shiftId };
    },
  });
}

/**
 * `is_weekly_off(rule, date, employee)` for the RESOLVED weekly-off rule.
 * Dependent on the resolution above, hence its own hook and its own `enabled`.
 */
export function useIsWeeklyOff(
  ruleId: string | null,
  isoDate: string,
  employeeId: string | null,
): UseQueryResult<boolean, Error> {
  return useQuery({
    queryKey: qk.admin.orgList("isWeeklyOff", {
      ruleId: ruleId ?? "",
      isoDate,
      employeeId: employeeId ?? "",
    }),
    enabled: ruleId !== null && ruleId !== "" && employeeId !== null && employeeId !== "",
    retry: shouldRetryQuery,
    queryFn: ({ signal }) => resolveIsWeeklyOff(ruleId ?? "", isoDate, employeeId ?? "", signal),
  });
}

/**
 * Names for the winning ids. Read by id (not from the active-rows list) on
 * purpose: a binding may point at a policy that has since been deactivated, and
 * the resolver must still name it — that is often the bug being chased.
 */
export function useResolvedPolicyRefs(
  resolved: ResolvedPolicyIds | undefined,
): UseQueryResult<ReadonlyMap<string, PolicyRef>, Error> {
  const pairs = resolved
    ? assignmentKindValues
        .map((kind) => ({ kind, id: resolved[kind] }))
        .filter((pair): pair is { kind: AssignmentKind; id: string } => pair.id !== null)
    : [];

  return useQuery({
    queryKey: qk.admin.orgList("resolvedPolicyRefs", {
      ids: pairs.map((pair) => `${pair.kind}:${pair.id}`).sort().join(","),
    }),
    enabled: pairs.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
    queryFn: async ({ signal }) => {
      const byTable = new Map<string, Set<string>>();
      for (const pair of pairs) {
        const table = KIND_POLICY_TABLE[pair.kind];
        if (table === undefined) continue;
        const set = byTable.get(table) ?? new Set<string>();
        set.add(pair.id);
        byTable.set(table, set);
      }
      const maps = await Promise.all(
        [...byTable].map(([table, ids]) => fetchRefsByIds(table, [...ids], signal)),
      );
      return mergeMaps(maps);
    },
  });
}

/**
 * The candidate list: every LIVE binding whose window contains the date, whatever
 * its scope. `policy_assignments` is a config table (18 rows live), so this is a
 * bounded whole-table read; the page then keeps the rows whose scope target
 * matches THIS employee and ranks them by `SCOPE_RANK`.
 */
export function useAssignmentCandidates(
  isoDate: string,
): UseQueryResult<PolicyAssignment[], Error> {
  const filters: AssignmentFilters = { startedBy: isoDate };
  return useQuery({
    queryKey: [...assignmentKey(filters), "candidates"],
    queryFn: async ({ signal }) => {
      const rows = await fetchPolicyAssignments(filters, 500, signal);
      return rows.filter((row) => coversDate(row, isoDate));
    },
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 4. The five steps of resolve_shift_for_date, as data
// -----------------------------------------------------------------------------

export interface ShiftTrace {
  /** Step 1 — the published roster slot, or null. */
  readonly rosterSlot: RosterSlotRef | null;
  /** Step 2 — dated shift assignments that have started, newest first. */
  readonly shiftAssignments: readonly ShiftAssignment[];
  /** Step 4 — the designation's default. */
  readonly designation: DesignationShift | null;
  /** Step 5 — the company's `G` shift. */
  readonly companyDefault: ShiftDetail | null;
}

/**
 * The four rows the shift precedence walks (step 3 is a column on the employee
 * row the page already holds). One query, so the trace is internally consistent:
 * four separate hooks could each settle against a different moment.
 */
export function useShiftTrace(
  employee: AdminEmployee | null | undefined,
  isoDate: string,
): UseQueryResult<ShiftTrace, Error> {
  const employeeId = employee?.id ?? "";
  const designationId = employee?.designation_id ?? null;
  const companyId = employee?.company_id ?? null;

  return useQuery({
    queryKey: qk.admin.orgList("shiftTrace", { employeeId, isoDate }),
    enabled: employeeId !== "",
    retry: shouldRetryQuery,
    queryFn: async ({ signal }): Promise<ShiftTrace> => {
      const [rosterSlot, shiftAssignments, designation, companyDefault] = await Promise.all([
        fetchPublishedRosterSlot(employeeId, isoDate, signal),
        fetchShiftAssignments(employeeId, isoDate, signal),
        designationId === null
          ? Promise.resolve(null)
          : fetchDesignationDefaultShift(designationId, signal),
        companyId === null ? Promise.resolve(null) : fetchCompanyDefaultShift(companyId, signal),
      ]);
      return { rosterSlot, shiftAssignments, designation, companyDefault };
    },
  });
}

/**
 * Names for the shift ids the trace turns up. A step that answered with a uuid
 * has to say WHICH shift on screen — a raw id is not an answer (D-10).
 */
export function useShiftRefs(
  shiftIds: readonly string[],
): UseQueryResult<ReadonlyMap<string, PolicyRef>, Error> {
  const ids = [...new Set(shiftIds)].sort();
  return useQuery({
    queryKey: qk.admin.orgList("shiftRefs", { ids: ids.join(",") }),
    enabled: ids.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
    queryFn: ({ signal }) => fetchRefsByIds(SHIFTS_TABLE, ids, signal),
  });
}

/** The resolved shift itself, for the "this is what the engine will use" card. */
export function useShiftDetail(shiftId: string | null): UseQueryResult<ShiftDetail | null, Error> {
  return useQuery({
    queryKey: qk.admin.orgList("shiftDetail", { shiftId: shiftId ?? "" }),
    enabled: shiftId !== null && shiftId !== "",
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
    queryFn: ({ signal }) => fetchShiftDetail(shiftId ?? "", signal),
  });
}

/** What the RESOLVED holiday calendar says about that exact date. */
export function useHolidaysOnDate(
  calendarId: string | null,
  isoDate: string,
): UseQueryResult<HolidayOnDate[], Error> {
  return useQuery({
    queryKey: qk.admin.orgList("holidayOnDate", { calendarId: calendarId ?? "", isoDate }),
    enabled: calendarId !== null && calendarId !== "",
    retry: shouldRetryQuery,
    queryFn: ({ signal }) => fetchHolidaysOnDate(calendarId ?? "", isoDate, signal),
  });
}

/** The pay period whose own window contains the date (no assignment involved). */
export function usePayPeriodForDate(
  isoDate: string,
): UseQueryResult<PayPeriodOnDate | null, Error> {
  return useQuery({
    queryKey: qk.admin.orgList("payPeriodForDate", { isoDate }),
    queryFn: ({ signal }) => fetchPayPeriodForDate(isoDate, signal),
    retry: shouldRetryQuery,
  });
}
