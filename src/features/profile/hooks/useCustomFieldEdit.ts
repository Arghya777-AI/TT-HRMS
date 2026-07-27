/**
 * useCustomFieldEdit.ts — the write side of E-07.5 (/me/profile/custom).
 *
 * A separate file from `useProfile.ts` on purpose: that module is the seven
 * tabs' shared READ surface and every page imports it, so the two mutations and
 * the one derived selector added here do not belong in it.
 *
 * Invalidation is `qk.profile.all` — the whole domain, not just
 * `qk.profile.customFields`. That is deliberate rather than lazy:
 * `employees.profile_completeness_pct` is a SERVER column whose 12-item
 * weighting includes "uniform + shoe size", so a saved custom field genuinely
 * changes the completeness bar `ProfileShell` renders from `qk.profile.me()`.
 * Refreshing only the field grid would leave the header stale and wrong.
 *
 * Nothing is optimistic. A value the database has not confirmed is never drawn
 * as saved — the whole point of the authority model is that an employee finds
 * out what actually happened.
 */
import { useMemo } from "react";
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { requireEmployeeId, useEmployeeId, useProfileId } from "@/shared/api/employee-scope";
import { QueryError } from "@/shared/api/query";
import {
  requestCustomFieldChange,
  saveCustomFieldValue,
  customFieldCodeOf,
  type CustomFieldDef,
  type CustomFieldDraft,
  type CustomFieldValue,
} from "../api/custom-fields.api";
import {
  OPEN_CHANGE_REQUEST_STATUSES,
  type ChangeRequest,
} from "../api/history.api";
import { useChangeRequests } from "./useProfile";

function requireProfileId(profileId: string | null): string {
  if (profileId === null || profileId.length === 0) {
    throw new QueryError(
      "identity",
      "no_permission",
      "This account has no signed-in profile, so it cannot raise a change request.",
    );
  }
  return profileId;
}

// -----------------------------------------------------------------------------
// 1. What is already in flight, per field code
// -----------------------------------------------------------------------------

export interface CustomFieldRequestState {
  /** Still open — `[Send to HR]` must be blocked so the queue stays one-deep. */
  readonly open: ChangeRequest | null;
  /**
   * HR approved it and `apply_change_request` could not write it: status
   * 'failed' with `apply_error` set. The employee has to be told, because from
   * their side an approval that changed nothing looks like a lie.
   */
  readonly failed: ChangeRequest | null;
}

const NO_REQUESTS: CustomFieldRequestState = { open: null, failed: null };

export function noCustomFieldRequests(): CustomFieldRequestState {
  return NO_REQUESTS;
}

/**
 * `code → { open, failed }` over the caller's own change requests.
 *
 * Reads the SAME `qk.profile.changeRequests` cache entry the History tab uses,
 * so the amber "waiting on HR" line here and the row on Tab 8 can never
 * disagree about the same request.
 */
export function useCustomFieldRequestStates(): {
  readonly byCode: ReadonlyMap<string, CustomFieldRequestState>;
  readonly isPending: boolean;
  readonly error: Error | null;
} {
  const requests = useChangeRequests();
  const rows = requests.data;

  const byCode = useMemo<ReadonlyMap<string, CustomFieldRequestState>>(() => {
    const out = new Map<string, CustomFieldRequestState>();
    if (rows === undefined) return out;
    // Newest first from the query, so the FIRST match per code wins in each
    // category and a decided request never masks the one still in flight.
    for (const request of rows) {
      const code = customFieldCodeOf(request);
      if (code === null) continue;
      const current = out.get(code) ?? NO_REQUESTS;
      const isOpen = OPEN_CHANGE_REQUEST_STATUSES.includes(request.status);
      const isFailed = request.status === "failed";
      if (isOpen && current.open === null) {
        out.set(code, { open: request, failed: current.failed });
        continue;
      }
      if (isFailed && current.failed === null && current.open === null) {
        out.set(code, { open: current.open, failed: request });
      }
    }
    return out;
  }, [rows]);

  return { byCode, isPending: requests.isPending, error: requests.error };
}

// -----------------------------------------------------------------------------
// 2. The two writes
// -----------------------------------------------------------------------------

export interface SaveCustomFieldInput {
  readonly def: CustomFieldDef;
  /** `employee_custom_field_values.id`, or null when there is no value yet. */
  readonly valueRowId: string | null;
  readonly draft: CustomFieldDraft;
}

/**
 * Direct write, for `requires_approval = false` fields.
 *
 * A 42501 here is NOT swallowed: it means `ecfv__self_insert` /
 * `ecfv__self_update` (migration 20260801014000) are not applied on this
 * project. The screen catches it and offers the change-request path instead, so
 * the employee's value survives a database that is one migration behind.
 */
export function useSaveCustomFieldValue(): UseMutationResult<
  CustomFieldValue,
  Error,
  SaveCustomFieldInput
> {
  const client = useQueryClient();
  const employeeId = useEmployeeId();
  return useMutation({
    mutationFn: (input: SaveCustomFieldInput) =>
      saveCustomFieldValue({
        employeeId: requireEmployeeId(employeeId),
        def: input.def,
        valueRowId: input.valueRowId,
        draft: input.draft,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.profile.all });
    },
  });
}

export interface RequestCustomFieldInput {
  readonly def: CustomFieldDef;
  readonly draft: CustomFieldDraft;
  /** The value on the record now — the From half of the queue's From → To. */
  readonly current: CustomFieldDraft | null;
}

/** Maker-checker write: propose the value, HR decides it. */
export function useRequestCustomFieldChange(): UseMutationResult<
  ChangeRequest,
  Error,
  RequestCustomFieldInput
> {
  const client = useQueryClient();
  const employeeId = useEmployeeId();
  const profileId = useProfileId();
  return useMutation({
    mutationFn: (input: RequestCustomFieldInput) =>
      requestCustomFieldChange({
        employeeId: requireEmployeeId(employeeId),
        requestedBy: requireProfileId(profileId),
        def: input.def,
        draft: input.draft,
        current: input.current,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.profile.all });
    },
  });
}
