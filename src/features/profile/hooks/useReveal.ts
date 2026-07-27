/**
 * useReveal.ts — the audited reveal for Tab 3's statutory ids and bank account.
 *
 * The audit is not a client concern here, and that is the point: the migration-032
 * `reveal_*` functions write the `data_access_log` row (actor, fields, written
 * purpose, ip, user agent) BEFORE returning a value. A reveal that returns data
 * has necessarily been logged; there is no code path that shows a number without
 * recording it. The employee reads that same log back on the History tab.
 *
 * On failure the mutation error is left intact rather than swallowed, because the
 * two failure modes mean different things to the person on screen:
 *   * `no_permission` (42501) — the full number is not sent to this browser at
 *     all. The masked value the tab already shows is the ceiling. This is the
 *     normal outcome for a non-admin employee and is NOT an error to apologise
 *     for; the page states the policy.
 *   * `unknown` (22023) — the reason was under 10 characters. The form asks again.
 */
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { requireEmployeeId, useEmployeeId } from "@/shared/api/employee-scope";
import { QueryError } from "@/shared/api/query";
import {
  REVEAL_REASON_MIN_LENGTH,
  revealBankAccounts,
  revealStatutory,
  type RevealedBankAccount,
  type RevealedStatutory,
} from "../api/payment.api";

export interface RevealInput {
  /** Written purpose, ≥10 characters — the server rejects anything shorter. */
  readonly reason: string;
}

/** True when the failure means "this browser is never sent the full value". */
export function isRevealForbidden(error: unknown): boolean {
  return error instanceof QueryError && error.kind === "no_permission";
}

/** True when the server refused because the stated reason was too short. */
export function isReasonTooShort(reason: string): boolean {
  return reason.trim().length < REVEAL_REASON_MIN_LENGTH;
}

/**
 * Reveal the full PAN / Aadhaar / UAN / PF / ESI numbers.
 *
 * On success the caller's own `v_my_data_access` list is invalidated so the new
 * log entry appears on the History tab immediately — the transparency surface
 * updates in the same session as the reveal that caused it.
 */
export function useRevealStatutory(): UseMutationResult<
  RevealedStatutory | null,
  Error,
  RevealInput
> {
  const employeeId = useEmployeeId();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ reason }: RevealInput) =>
      revealStatutory(requireEmployeeId(employeeId), reason),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.profile.dataAccess(employeeId ?? "none") });
    },
    retry: false,
  });
}

/** Reveal the full bank account numbers. Same authority and logging rules. */
export function useRevealBankAccounts(): UseMutationResult<
  RevealedBankAccount[],
  Error,
  RevealInput
> {
  const employeeId = useEmployeeId();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ reason }: RevealInput) =>
      revealBankAccounts(requireEmployeeId(employeeId), reason),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.profile.dataAccess(employeeId ?? "none") });
    },
    retry: false,
  });
}
