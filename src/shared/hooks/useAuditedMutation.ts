/**
 * useAuditedMutation.ts — the ONE TanStack wrapper for a write that carries an
 * audit reason.
 *
 * What it guarantees, so that seven admin screens do not each re-derive it:
 *
 *  1. The reason is validated on the CLIENT before the request is made, so a
 *     nine-character reason is a form error, not a round trip that comes back
 *     as SQLSTATE 22023.
 *  2. Exactly one reason belongs to exactly one write. The reason travels as an
 *     argument through `mutate()` into the `x-reason` header of that request —
 *     never through module state that two concurrent saves could interleave.
 *  3. On success the given query-key PREFIXES are invalidated, so the grid the
 *     admin is looking at refreshes from the server rather than from an
 *     optimistic guess. A dashboard tile and its detail drawer cannot disagree
 *     because neither of them holds a locally-patched copy.
 *  4. `userMessage` is always available on failure (`result.userMessage`), in
 *     plain English, for the form's error slot.
 *
 * It intentionally does NOT do optimistic updates. Every number on an admin
 * screen is server-computed (attendance, leave, payroll); a client-side guess at
 * the post-write state is exactly how a screen starts lying.
 */
import {
  useMutation,
  useQueryClient,
  type QueryKey,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import {
  MIN_REASON_LENGTH,
  assertReason,
  isReasonValid,
  mutationUserMessage,
} from "@/shared/api/query";

/**
 * What `mutate` takes: the payload, plus the reason for this particular save.
 * `reason` may be omitted only when the hook was given a `defaultReason` — the
 * routine-field-edit case ("admin console: edited employment details"). Salary,
 * bank, role and lock changes pass a reason the human typed.
 */
export interface AuditedVariables<TInput> {
  readonly input: TInput;
  readonly reason?: string;
}

export interface UseAuditedMutationOptions<TData, TInput> {
  /** Performs the write. Receives the validated, trimmed reason. */
  readonly mutationFn: (input: TInput, reason: string) => Promise<TData>;
  /**
   * Query-key prefixes to invalidate on success. Use the WIDEST prefix that is
   * correct (`qk.admin.employees()`, not one row's key) — a stale sibling list
   * is the same defect as a stale grid.
   */
  readonly invalidate?: readonly QueryKey[];
  /**
   * Reason used when the caller does not supply one. Acceptable for routine
   * field edits only; leave it undefined for anything sensitive so the call
   * fails loudly rather than inventing a justification.
   */
  readonly defaultReason?: string;
  /** Client-side floor. Defaults to the database's 10 (D-21 actions pass 15). */
  readonly minReasonLength?: number;
  readonly onSuccess?: (data: TData, input: TInput, reason: string) => void;
  readonly onError?: (error: Error, input: TInput) => void;
}

/**
 * `UseMutationResult` is a discriminated union, so this is an intersection rather
 * than an `interface extends` — the union's narrowing (`isPending`, `isError`)
 * has to survive.
 */
export type AuditedMutationResult<TData, TInput> = UseMutationResult<
  TData,
  Error,
  AuditedVariables<TInput>
> & {
  /** `mutate` with the two arguments spelled out — the ergonomic form. */
  readonly save: (input: TInput, reason?: string) => void;
  /** Promise form, for a wizard step that must await the row. */
  readonly saveAsync: (input: TInput, reason?: string) => Promise<TData>;
  /** Plain-English sentence for the failure, or null while things are fine. */
  readonly userMessage: string | null;
  /** True when this reason would pass the client-side check. Gate Save on it. */
  readonly isReasonAcceptable: (reason: string | null | undefined) => boolean;
  /** The floor in force, for the dialog's character counter. */
  readonly minReasonLength: number;
};

export function useAuditedMutation<TData, TInput>(
  opts: UseAuditedMutationOptions<TData, TInput>,
): AuditedMutationResult<TData, TInput> {
  const queryClient = useQueryClient();
  const minLength = opts.minReasonLength ?? MIN_REASON_LENGTH;
  const { mutationFn, invalidate, defaultReason, onSuccess, onError } = opts;

  const mutation = useMutation<TData, Error, AuditedVariables<TInput>>({
    mutationFn: async (vars: AuditedVariables<TInput>) => {
      // Throws MutationError{ mutationKind: 'reason_required' } before the
      // request when the sentence is too short or missing entirely.
      const reason = assertReason(vars.reason ?? defaultReason, { minLength });
      return mutationFn(vars.input, reason);
    },
    onSuccess: (data, vars) => {
      for (const key of invalidate ?? []) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      onSuccess?.(data, vars.input, (vars.reason ?? defaultReason ?? "").trim());
    },
    onError: (error, vars) => {
      /*
        THE RAW ERROR, IN THE CONSOLE, IN DEVELOPMENT.

        A policy upload failed three times in a row showing only "The change could
        not be saved" — and each attempt to widen `userMessage` guessed at which
        branch was rendering it, because the error object itself was never
        visible anywhere. Two rounds of patching the SENTENCE went by before
        anybody could see the FAULT.

        A user-facing sentence is deliberately narrow: it must not print SQL, a
        constraint name, or a storage path. The console has no such duty and is
        where the person fixing it is already looking. Dev only — a production
        console must not carry payload detail, and `import.meta.env.DEV` is
        compiled out of the production bundle entirely.
      */
      if (import.meta.env.DEV) {
        const e = error as { message?: string; code?: unknown; details?: unknown; hint?: unknown };
        console.error("[write failed]", {
          message: e.message,
          code: e.code ?? null,
          details: e.details ?? null,
          hint: e.hint ?? null,
          error,
        });
      }
      onError?.(error, vars.input);
    },
    // A refused write is refused for a reason the user has to act on; retrying
    // the identical payload only writes the same failure to the log twice.
    retry: false,
  });

  const { mutate, mutateAsync } = mutation;

  const save = useCallback(
    (input: TInput, reason?: string) => {
      mutate(reason === undefined ? { input } : { input, reason });
    },
    [mutate],
  );

  const saveAsync = useCallback(
    (input: TInput, reason?: string) =>
      mutateAsync(reason === undefined ? { input } : { input, reason }),
    [mutateAsync],
  );

  const isReasonAcceptable = useCallback(
    (reason: string | null | undefined) => isReasonValid(reason, minLength),
    [minLength],
  );

  const userMessage = useMemo(
    () => (mutation.error ? mutationUserMessage(mutation.error) : null),
    [mutation.error],
  );

  return {
    ...mutation,
    save,
    saveAsync,
    userMessage,
    isReasonAcceptable,
    minReasonLength: minLength,
  };
}
