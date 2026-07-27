/**
 * useSelfEdit.ts — the hooks behind employee self-service editing.
 *
 * The interesting part is `useFieldChangeState`, which answers the question that
 * generates the support ticket: "I asked for this — where is it?"
 *
 * TWO ROWS DESCRIBE ONE REQUEST, and they disagree by design:
 *
 *   * `employee_change_requests` holds WHAT was asked for. Its `status` moves
 *     only under `service_role` (migration 011 §4 grants the employee SELECT and
 *     INSERT and nothing else), so from a browser it is frozen at `'pending'`
 *     forever — even after the employee takes the request back.
 *   * `approval_requests` holds WHERE the request is. `act_on_approval` moves it
 *     to `withdrawn` / `rejected` / `approved`, and `features/team`'s
 *     `decideApproval` documents that this engine never writes back to a detail
 *     table.
 *
 * So the APPROVAL row wins wherever both exist, and the change-request row is
 * the fallback for rows raised before an approval could be created (or by HR on
 * the employee's behalf). Reading only the detail row is what would leave a
 * withdrawn request showing "awaiting HR approval" until the end of time.
 *
 * `useChangeRequests` and `useMyFieldChangeApprovals` are called by EVERY
 * editable row on the page. That is deliberate and free: both are TanStack
 * queries under one key each, so twenty rows share two fetches and one cache
 * entry, and one retry fixes the whole tab.
 */
import { useMemo } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import {
  MIN_REASON_LENGTH,
  QueryError,
  mutationUserMessage,
  shouldRetryQuery,
} from "@/shared/api/query";
import { requireEmployeeId, useEmployeeId, useProfileId } from "@/shared/api/employee-scope";
import { t } from "@/shared/i18n/en";
import {
  fetchMyFieldChangeApprovals,
  submitFieldChangeRequest,
  updateSelfEditableField,
  withdrawFieldChangeApproval,
  type FieldChangeApproval,
  type SelfEdited,
  type SubmittedFieldChange,
} from "../api/self-edit.api";
import { isOpenChangeRequest, type ApprovalStatus, type ChangeRequest } from "../api/history.api";
import { useChangeRequests } from "./useProfile";
import { fieldLabel, type EditableField } from "../self-edit";

// -----------------------------------------------------------------------------
// 1. Reads
// -----------------------------------------------------------------------------

export function useMyFieldChangeApprovals(): UseQueryResult<FieldChangeApproval[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.profile.detail(`field-change-approvals:${employeeId ?? "none"}`),
    queryFn: ({ signal }) => fetchMyFieldChangeApprovals(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
    staleTime: 30_000,
  });
}

// -----------------------------------------------------------------------------
// 2. The per-field state
// -----------------------------------------------------------------------------

/**
 * What the employee is told about this field right now.
 *
 * `open` is the only stage that blocks a second request: the table has no
 * uniqueness on (employee, field, status), so two pending rows for one field are
 * physically possible and are exactly the mess an employee cannot clean up
 * (no UPDATE, no DELETE).
 */
export type FieldChangeStage =
  | "open"
  | "approved_not_applied"
  | "rejected"
  | "withdrawn"
  | "expired"
  | "failed";

export interface FieldChangeState {
  readonly stage: FieldChangeStage;
  readonly changeRequestId: string;
  /** Null when no approval row exists — an HR-raised or unrouted request. */
  readonly approvalRequestId: string | null;
  readonly reference: string | null;
  /** jsonb value asked for, rendered by the caller through `displayRequestValue`. */
  readonly requestedValue: unknown;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly comment: string | null;
  readonly applyError: string | null;
  /** True while the approval is open AND recallable by the subject. */
  readonly canWithdraw: boolean;
}

function stageFor(
  request: ChangeRequest,
  approval: FieldChangeApproval | undefined,
): FieldChangeStage | null {
  // The detail row's own terminal states win: `applied` means the value on the
  // record already IS the requested one, and `failed` is the visible-failure
  // state `apply_change_request` writes when its UPDATE raises.
  if (request.status === "failed") return "failed";
  if (request.status === "applied") return null;

  const status: ApprovalStatus = approval?.status ?? request.status;
  if (status === "withdrawn" || status === "cancelled") return "withdrawn";
  if (status === "rejected") return "rejected";
  if (status === "expired") return "expired";
  if (status === "approved" || status === "auto_approved") return "approved_not_applied";
  if (isOpenChangeRequest(status)) return "open";
  return null;
}

/**
 * The newest state per `employees` column, from the two sources.
 *
 * Newest-first ordering comes from the queries (`requested_at DESC`), so the
 * first row seen for a column is the current one and older rows for the same
 * field are ignored — an employee needs to know about the request in flight, not
 * the three they sent last year.
 */
export function buildFieldStates(
  requests: readonly ChangeRequest[],
  approvals: readonly FieldChangeApproval[],
): ReadonlyMap<string, FieldChangeState> {
  const approvalByDetail = new Map<string, FieldChangeApproval>();
  for (const approval of approvals) {
    if (!approvalByDetail.has(approval.detail_id)) approvalByDetail.set(approval.detail_id, approval);
  }

  const out = new Map<string, FieldChangeState>();
  for (const request of requests) {
    if (request.entity_table !== "employees") continue;
    if (out.has(request.field_name)) continue;
    const approval = approvalByDetail.get(request.id);
    const stage = stageFor(request, approval);
    if (stage === null) continue;
    out.set(request.field_name, {
      stage,
      changeRequestId: request.id,
      approvalRequestId: approval?.id ?? null,
      reference: approval?.request_number ?? null,
      requestedValue: request.new_value,
      requestedAt: request.requested_at,
      decidedAt: approval?.decided_at ?? request.decided_at,
      comment: approval?.decision_comment ?? request.decision_comment,
      applyError: request.apply_error,
      canWithdraw: stage === "open" && approval !== undefined,
    });
  }
  return out;
}

export interface FieldChangeStates {
  readonly byColumn: ReadonlyMap<string, FieldChangeState>;
  readonly loading: boolean;
  /**
   * True when either source failed. The row then says it could not check rather
   * than showing a confident "nothing waiting" over a read that never landed.
   */
  readonly unavailable: boolean;
  readonly error: Error | null;
}

export function useFieldChangeStates(): FieldChangeStates {
  const requests = useChangeRequests();
  const approvals = useMyFieldChangeApprovals();

  const byColumn = useMemo(
    () => buildFieldStates(requests.data ?? [], approvals.data ?? []),
    [requests.data, approvals.data],
  );

  return {
    byColumn,
    loading: requests.isPending || approvals.isPending,
    unavailable: requests.error !== null || approvals.error !== null,
    error: requests.error ?? approvals.error,
  };
}

/** The state for one column, or null when nothing is in flight on it. */
export function useFieldChangeState(column: EditableField): {
  readonly state: FieldChangeState | null;
  readonly loading: boolean;
  readonly unavailable: boolean;
} {
  const all = useFieldChangeStates();
  return {
    state: all.byColumn.get(column) ?? null,
    loading: all.loading,
    unavailable: all.unavailable,
  };
}

// -----------------------------------------------------------------------------
// 3. Writes
// -----------------------------------------------------------------------------

/**
 * The sentence to show for a failed self-edit.
 *
 * `mutationUserMessage` maps a database refusal to the catalogue sentence for its
 * KIND — which is right for a 42501 or a 23514, and wrong for the two failures
 * this feature raises itself ("no signed-in profile", "the change was recorded
 * but the approval was not routed"). Those arrive as a plain `Error` already
 * carrying their own English, so they are passed through instead of being
 * flattened into "not found".
 */
export function selfEditErrorMessage(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  if (error instanceof QueryError) return mutationUserMessage(error);
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return mutationUserMessage(error);
}

/**
 * Invalidate everything a field change can move: THE profile row (a direct edit
 * changed it, and `profile_completeness_pct` with it), the change-request list,
 * the approval rows, and the employee's own open-requests list on /me/apply —
 * a profile change now appears there like any other approval.
 */
function useInvalidateAfterFieldChange(): () => void {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: qk.profile.all });
    void client.invalidateQueries({ queryKey: qk.apply.all });
  };
}

export interface SubmitFieldChangeVars {
  readonly column: EditableField;
  readonly newValue: string | boolean;
  readonly oldValue: string | boolean | null;
  readonly oldDisplay: string;
  readonly newDisplay: string;
  readonly reason: string;
}

export function useSubmitFieldChange(): UseMutationResult<
  SubmittedFieldChange,
  Error,
  SubmitFieldChangeVars
> {
  const employeeId = useEmployeeId();
  const profileId = useProfileId();
  const invalidate = useInvalidateAfterFieldChange();

  return useMutation({
    mutationFn: (vars: SubmitFieldChangeVars) => {
      // `ecr__self_insert` checks `requested_by = app.ctx_actor_id()`, so a
      // missing profile id cannot be papered over with the employee id.
      if (profileId === null || profileId === "") {
        return Promise.reject(new Error(t("me.edit.error.noProfile")));
      }
      return submitFieldChangeRequest({
        employeeId: requireEmployeeId(employeeId),
        profileId,
        fieldName: vars.column,
        fieldLabel: fieldLabel(vars.column),
        oldValue: vars.oldValue,
        newValue: vars.newValue,
        oldDisplay: vars.oldDisplay,
        newDisplay: vars.newDisplay,
        reason: vars.reason,
      });
    },
    onSuccess: invalidate,
  });
}

export interface SelfEditVars {
  readonly column: "about" | "food_preference";
  readonly value: string;
  /**
   * The employee's own note when they wrote one. Blank is allowed and becomes a
   * truthful default sentence, because `public.employees` is reason-gated for
   * UPDATE and a routine self-edit has no justification to give — see
   * `ReasonDialog`'s own note that a default sentence is acceptable for routine
   * field edits.
   */
  readonly note: string;
}

export function useUpdateSelfField(): UseMutationResult<SelfEdited, Error, SelfEditVars> {
  const employeeId = useEmployeeId();
  const invalidate = useInvalidateAfterFieldChange();

  return useMutation({
    mutationFn: (vars: SelfEditVars) => {
      // `assertReason` inside `updateRow` refuses fewer than MIN_REASON_LENGTH
      // characters before the request leaves the browser, and this screen tells
      // the employee the note is optional. So a blank OR a short note is wrapped
      // in the truthful default sentence rather than being sent to fail: the
      // audit row still records what happened and what they wrote.
      const note = vars.note.trim();
      const field = fieldLabel(vars.column);
      const reason =
        note.length >= MIN_REASON_LENGTH
          ? note
          : note === ""
            ? t("me.edit.audit.selfDefault", { field })
            : t("me.edit.audit.selfWithNote", { field, note });
      return updateSelfEditableField({
        employeeId: requireEmployeeId(employeeId),
        column: vars.column,
        value: vars.value,
        reason,
      });
    },
    onSuccess: invalidate,
  });
}

export interface WithdrawFieldChangeVars {
  readonly approvalRequestId: string;
}

export function useWithdrawFieldChange(): UseMutationResult<
  ApprovalStatus,
  Error,
  WithdrawFieldChangeVars
> {
  const invalidate = useInvalidateAfterFieldChange();
  return useMutation({
    mutationFn: (vars: WithdrawFieldChangeVars) =>
      withdrawFieldChangeApproval({
        approvalRequestId: vars.approvalRequestId,
        comment: t("me.edit.audit.withdraw"),
      }),
    onSuccess: invalidate,
  });
}
