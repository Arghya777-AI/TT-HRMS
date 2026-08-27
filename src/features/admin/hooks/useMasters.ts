/**
 * useMasters.ts — TanStack hooks over org.api / payPeriods.api for the twelve
 * lookup-master screens.
 *
 * Rules this file exists to keep:
 *  - Keys come from `qk.admin.*` only. Every org master lives under the
 *    `["admin","org",…]` prefix, so ONE invalidation after a write refreshes
 *    the grid, the pickers that reference it and the drawer above it — the
 *    structural fix for a tile disagreeing with its own detail view.
 *  - Writes go through `useAuditedMutation`, which validates the reason in the
 *    browser and puts it in the `x-reason` header of that one request.
 *  - Sensitive writes (retire, deactivate, pay-period windows, entity details)
 *    pass NO `defaultReason`. If a screen forgets to prompt, the mutation
 *    fails loudly instead of inventing a justification.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { z } from "zod";
import { useMemo } from "react";
import { qk } from "@/shared/api/keys";
import { SENSITIVE_REASON_LENGTH, shouldRetryQuery } from "@/shared/api/query";
import {
  useAuditedMutation,
  type AuditedMutationResult,
} from "@/shared/hooks/useAuditedMutation";
import { fetchEmployeeOptions } from "../api/employees.api";
import { insertPayPeriod, updatePayPeriod } from "../api/payPeriods.api";
import { fetchPayPeriods, type PayPeriod } from "../api/payroll.api";
import {
  ORG_ENTITIES,
  REASON_ORG_MASTER,
  archiveOrgRow,
  deactivateHoliday,
  fetchCompanies,
  fetchHolidays,
  fetchOrgList,
  insertHoliday,
  insertOrgRow,
  updateCompany,
  updateHoliday,
  updateOrgRow,
  type Company,
  type Holiday,
  type HolidayInput,
  type OrgEntityKey,
  type OrgListFilters,
  fetchSelfPunchRestrictedDepartmentIds,} from "../api/org.api";

/** A picker entry: an id and the NAME to render. Codes never reach a picker. */
export interface RefOption {
  readonly id: string;
  readonly name: string;
}

type OrgRow<K extends OrgEntityKey> = z.infer<(typeof ORG_ENTITIES)[K]["schema"]>;

/**
 * Query keys have to be plain data, and `OrgListFilters` is an interface, so it
 * is spread into a literal rather than passed through.
 */
function orgListKey(entity: string, f: OrgListFilters) {
  return qk.admin.orgList(entity, {
    includeInactive: f.includeInactive === true,
    archived: f.archived === true,
    nameLike: f.nameLike ?? "",
    parent: f.parent ?? null,
  });
}

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

/** One org/time master list. Row type follows the entity — no cast at the page. */
export function useOrgList<K extends OrgEntityKey>(
  entity: K,
  filters: OrgListFilters = {},
): UseQueryResult<OrgRow<K>[], Error> {
  return useQuery({
    queryKey: orgListKey(entity, filters),
    queryFn: ({ signal }) => fetchOrgList(entity, filters, signal),
    retry: shouldRetryQuery,
  });
}

/**
 * The employing entities. `/admin/org/entities` renders these; every other
 * screen needs the default one's id, because `company_id` is NOT NULL on nine
 * of these tables.
 */
export function useCompanies(): UseQueryResult<Company[], Error> {
  return useQuery({
    queryKey: qk.admin.companies(),
    queryFn: ({ signal }) => fetchCompanies(signal),
    retry: shouldRetryQuery,
  });
}

/**
 * The company id new rows are created under. `null` while it is loading, or
 * when RLS shows this admin no entity — in which case the screen disables
 * creation and says so rather than sending a NULL company_id.
 */
export function useDefaultCompanyId(): string | null {
  const companies = useCompanies();
  const rows = companies.data ?? [];
  const preferred = rows.find((row) => row.is_active) ?? rows[0];
  return preferred?.id ?? null;
}

/** Active rows of a master, reduced to id + name for a picker. */
export function useRefOptions<K extends OrgEntityKey>(
  entity: K,
  enabled = true,
): UseQueryResult<RefOption[], Error> {
  return useQuery({
    queryKey: orgListKey(entity, { nameLike: "ref" }),
    queryFn: async ({ signal }) => {
      const rows = await fetchOrgList(entity, {}, signal);
      return rows.map((row) => ({ id: row.id, name: row.name }));
    },
    enabled,
    retry: shouldRetryQuery,
  });
}

/** Employees for a head/owner picker — name + code chip, never a mashup. */
export function useEmployeeRefOptions(): UseQueryResult<RefOption[], Error> {
  return useQuery({
    queryKey: qk.admin.employees({ picker: "org-master" }),
    queryFn: async ({ signal }) => {
      const rows = await fetchEmployeeOptions({}, 300, signal);
      return rows.map((row) => ({ id: row.id, name: row.display_name }));
    },
    retry: shouldRetryQuery,
  });
}

/** The holidays on one calendar. Disabled until a calendar is chosen. */
export function useHolidays(calendarId: string | null): UseQueryResult<Holiday[], Error> {
  return useQuery({
    queryKey: qk.admin.holidays(calendarId ?? "none", 0),
    queryFn: ({ signal }) => fetchHolidays(calendarId ?? "", {}, signal),
    enabled: calendarId !== null,
    retry: shouldRetryQuery,
  });
}

/** Pay periods, newest window first. */
export function usePayPeriods(): UseQueryResult<PayPeriod[], Error> {
  return useQuery({
    queryKey: qk.admin.payPeriods(),
    queryFn: ({ signal }) => fetchPayPeriods({}, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------------

export interface MasterSaveInput {
  /** null → insert. */
  readonly id: string | null;
  readonly values: Record<string, unknown>;
}

export type MasterSaveResult = AuditedMutationResult<unknown, MasterSaveInput>;

/**
 * Create or edit an org/time master.
 *
 * `alwaysPrompt` screens (shifts, weekly-offs, attendance policies, holidays)
 * get no default reason: their rows are the engine's inputs, and a config edit
 * that silently re-prices a department's attendance deserves a sentence.
 */
export function useMasterSave(
  entity: OrgEntityKey,
  opts: { readonly alwaysPrompt?: boolean } = {},
): MasterSaveResult {
  return useAuditedMutation<unknown, MasterSaveInput>({
    mutationFn: (input, reason) =>
      input.id === null
        ? insertOrgRow(entity, input.values, reason)
        : updateOrgRow(entity, input.id, input.values, reason),
    invalidate: [qk.admin.orgAll()],
    ...(opts.alwaysPrompt === true ? {} : { defaultReason: REASON_ORG_MASTER }),
  });
}

export interface MasterIdInput {
  readonly id: string;
}

/** Retire a master row (soft delete, D-23). Always prompts; floor is 15. */
export function useMasterArchive(entity: OrgEntityKey): AuditedMutationResult<void, MasterIdInput> {
  return useAuditedMutation<void, MasterIdInput>({
    mutationFn: (input, reason) => archiveOrgRow(entity, input.id, reason),
    invalidate: [qk.admin.orgAll()],
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}

export interface MasterActiveInput {
  readonly id: string;
  readonly isActive: boolean;
}

/**
 * Flip `is_active`. This is the deactivate path for the two tables with no
 * `deleted_at` (`weekly_off_rules`, `holidays`) and the reactivate path
 * everywhere else.
 */
export function useMasterSetActive(
  entity: OrgEntityKey,
): AuditedMutationResult<unknown, MasterActiveInput> {
  return useAuditedMutation<unknown, MasterActiveInput>({
    mutationFn: (input, reason) =>
      updateOrgRow(entity, input.id, { is_active: input.isActive }, reason),
    invalidate: [qk.admin.orgAll()],
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}

export interface HolidaySaveInput {
  readonly id: string | null;
  /** Create path — `holidays` has a typed input in org.api. */
  readonly create?: HolidayInput;
  /** Edit path — a column patch. */
  readonly patch?: Record<string, unknown>;
}

/**
 * Add or edit a holiday. `holidays` IS in `audit.reason_required_tables`, so a
 * missing reason is a hard 22023 from the database — hence no default.
 */
export function useHolidaySave(): AuditedMutationResult<Holiday, HolidaySaveInput> {
  return useAuditedMutation<Holiday, HolidaySaveInput>({
    mutationFn: (input, reason) => {
      if (input.id === null) {
        if (input.create === undefined) {
          return Promise.reject(new Error("useHolidaySave: create payload missing."));
        }
        return insertHoliday(input.create, reason);
      }
      if (input.patch === undefined) {
        return Promise.reject(new Error("useHolidaySave: patch payload missing."));
      }
      return updateHoliday(input.id, input.patch, reason);
    },
    invalidate: [qk.admin.orgAll()],
  });
}

/** Withdraw a holiday — `is_active = false`; holidays have no soft delete. */
export function useHolidayWithdraw(): AuditedMutationResult<Holiday, MasterIdInput> {
  return useAuditedMutation<Holiday, MasterIdInput>({
    mutationFn: (input, reason) => deactivateHoliday(input.id, reason),
    invalidate: [qk.admin.orgAll()],
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}

/** Create or edit a pay period. Super-admin territory; always prompts. */
export function usePayPeriodSave(): AuditedMutationResult<PayPeriod, MasterSaveInput> {
  return useAuditedMutation<PayPeriod, MasterSaveInput>({
    mutationFn: (input, reason) =>
      input.id === null
        ? insertPayPeriod(input.values, reason)
        : updatePayPeriod(input.id, input.values, reason),
    invalidate: [qk.admin.payPeriods(), qk.admin.payrollAll()],
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}

/** Edit the employing entity. Super-admin only, always prompts. */
export function useCompanySave(): AuditedMutationResult<Company, MasterSaveInput> {
  return useAuditedMutation<Company, MasterSaveInput>({
    mutationFn: (input, reason) => {
      if (input.id === null) {
        return Promise.reject(
          new Error("Legal entities are seeded by the database, not created in the console."),
        );
      }
      return updateCompany(input.id, input.values, reason);
    },
    invalidate: [qk.admin.companies()],
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}

/**
 * The department ids that forbid self-service punching, as a Set for the forms.
 *
 * Cached like the other reference reads — a department's punch rule changes when
 * management decides it does, not between two renders of a wizard step.
 */
export function useSelfPunchRestrictedDepartments(): ReadonlySet<string> {
  const q = useQuery({
    queryKey: qk.admin.orgList("selfPunchRestrictedDepartments", {}),
    queryFn: ({ signal }) => fetchSelfPunchRestrictedDepartmentIds(signal),
    retry: shouldRetryQuery,
    staleTime: 10 * 60_000,
  });
  return useMemo(() => new Set(q.data ?? []), [q.data]);
}
