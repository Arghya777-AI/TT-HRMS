/**
 * useCustomFieldDefs.ts — the hooks behind `/admin/org/custom-fields`.
 *
 * Keys sit under `qk.admin.orgList("customFieldDefs", …)` — the
 * `["admin","org",…]` prefix — so ONE `qk.admin.orgAll()` invalidation after a
 * save refreshes the grid, the tiles and the value-count column together. A tile
 * that lags its own grid is the `7 vs 8` defect, and it cannot happen if nothing
 * is patched locally.
 *
 * Every write goes through `useAuditedMutation` with NO `defaultReason`: these
 * rows decide what the venue asks its staff to disclose, and the PII flag on one
 * of them decides whether a manager can see the answer. A screen that forgot to
 * prompt should fail loudly rather than invent a justification.
 */
import { useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { SENSITIVE_REASON_LENGTH, shouldRetryQuery } from "@/shared/api/query";
import {
  useAuditedMutation,
  type AuditedMutationResult,
} from "@/shared/hooks/useAuditedMutation";
import {
  VALUE_COUNT_CAP,
  archiveCustomFieldDef,
  countCustomFieldDefs,
  fetchCustomFieldDefs,
  fetchValueCounts,
  insertCustomFieldDef,
  restoreCustomFieldDef,
  setCustomFieldActive,
  updateCustomFieldDef,
  type CustomFieldDefAdmin,
  type CustomFieldFilters,
} from "../api/custom-fields.api";

/** Query keys must be plain data; `CustomFieldFilters` is an interface. */
function defKey(f: CustomFieldFilters, part: string): Record<string, unknown> {
  return {
    part,
    includeInactive: f.includeInactive === true,
    archived: f.archived === true,
    labelLike: f.labelLike ?? "",
    section: f.section ?? "",
    fieldType: f.fieldType ?? "",
    piiOnly: f.piiOnly === true,
    employeeEditableOnly: f.employeeEditableOnly === true,
    requiredOnly: f.requiredOnly === true,
  };
}

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

export function useCustomFieldDefs(
  filters: CustomFieldFilters,
): UseQueryResult<CustomFieldDefAdmin[], Error> {
  return useQuery({
    queryKey: qk.admin.orgList("customFieldDefs", defKey(filters, "list")),
    queryFn: ({ signal }) => fetchCustomFieldDefs(filters, signal),
    retry: shouldRetryQuery,
  });
}

/** A tile's number, over the SAME predicate the grid uses. */
export function useCustomFieldCount(
  filters: CustomFieldFilters,
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.orgList("customFieldDefs", defKey(filters, "count")),
    queryFn: ({ signal }) => countCustomFieldDefs(filters, signal),
    retry: shouldRetryQuery,
  });
}

/**
 * "Values recorded" per definition: one server count each.
 *
 * `enabled` is honesty rather than optimisation — past `VALUE_COUNT_CAP`
 * definitions the query is not run and the column says the figure is unavailable
 * for a list this long, instead of counting rows the read may have capped.
 */
export function useCustomFieldValueCounts(
  defIds: readonly string[],
): UseQueryResult<ReadonlyMap<string, number>, Error> {
  const ids = useMemo(() => [...defIds].sort(), [defIds]);
  return useQuery({
    queryKey: qk.admin.orgList("customFieldDefs", { part: "value-counts", ids }),
    enabled: ids.length > 0 && ids.length <= VALUE_COUNT_CAP,
    queryFn: ({ signal }) => fetchValueCounts(ids, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------------

export interface CustomFieldSaveInput {
  /** null → insert. */
  readonly id: string | null;
  readonly values: Record<string, unknown>;
}

export function useCustomFieldSave(): AuditedMutationResult<
  CustomFieldDefAdmin,
  CustomFieldSaveInput
> {
  return useAuditedMutation<CustomFieldDefAdmin, CustomFieldSaveInput>({
    mutationFn: (input, reason) =>
      input.id === null
        ? insertCustomFieldDef(input.values, reason)
        : updateCustomFieldDef(input.id, input.values, reason),
    invalidate: [qk.admin.orgAll()],
  });
}

export interface CustomFieldIdInput {
  readonly id: string;
}

export interface CustomFieldActiveInput extends CustomFieldIdInput {
  readonly isActive: boolean;
}

/** Retire (soft delete). Floor 15 — a D-21 action on a live employee form. */
export function useCustomFieldArchive(): AuditedMutationResult<void, CustomFieldIdInput> {
  return useAuditedMutation<void, CustomFieldIdInput>({
    mutationFn: (input, reason) => archiveCustomFieldDef(input.id, reason),
    invalidate: [qk.admin.orgAll()],
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}

export function useCustomFieldRestore(): AuditedMutationResult<void, CustomFieldIdInput> {
  return useAuditedMutation<void, CustomFieldIdInput>({
    mutationFn: (input, reason) => restoreCustomFieldDef(input.id, reason),
    invalidate: [qk.admin.orgAll()],
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}

/** Flip `is_active`: stop asking the question, keep every answer already given. */
export function useCustomFieldSetActive(): AuditedMutationResult<
  CustomFieldDefAdmin,
  CustomFieldActiveInput
> {
  return useAuditedMutation<CustomFieldDefAdmin, CustomFieldActiveInput>({
    mutationFn: (input, reason) => setCustomFieldActive(input.id, input.isActive, reason),
    invalidate: [qk.admin.orgAll()],
    minReasonLength: SENSITIVE_REASON_LENGTH,
  });
}
