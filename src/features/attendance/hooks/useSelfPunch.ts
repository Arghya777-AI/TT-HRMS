/**
 * useSelfPunch.ts — query/mutation plumbing for the employee's own web punch.
 *
 * Keys come from `qk.attendance.*` only (frontend-contract §5). Both reads use
 * the domain's generic `detail(id)` factory rather than a new entry in the shared
 * key file, so `qk.attendance.all` still invalidates them and no shared module
 * has to change for this feature.
 *
 * A successful punch invalidates what it actually changed: the punch state
 * (which flips the button between Punch in and Punch out), the whole attendance
 * domain (timeline + month + summary), and the two home regions that read
 * today's row. The realtime subscription in `features/home` fires on the
 * `attendance_days` row the ENGINE writes, which lands after the punch — so the
 * card cannot wait for it and still feel instant.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { requireEmployeeId, useEmployeeId } from "@/shared/api/employee-scope";
import { istToday } from "@/lib/datetime";
import { playChime } from "@/shared/audio/chime";
import {
  fetchSelfPunchEligibility,
  fetchSelfPunchState,
  selfPunch,
  type SelfPunchEligibility,
  type SelfPunchOutcome,
  type SelfPunchRequest,
  type SelfPunchState,
} from "../api/selfPunch.api";

/** Key placeholder while identity resolves; the query is disabled anyway. */
const NO_EMPLOYEE = "no-employee";

/**
 * `allow_web_punch` for the signed-in employee. `null` = no employee row on this
 * login, which the card renders as nothing at all rather than a broken button.
 */
export function useSelfPunchEligibility(): UseQueryResult<SelfPunchEligibility | null, Error> {
  return useQuery({
    queryKey: qk.attendance.detail("self-punch:eligibility"),
    queryFn: ({ signal }) => fetchSelfPunchEligibility(signal),
    retry: shouldRetryQuery,
  });
}

/**
 * Which direction the next punch will be, predicted from the punches already
 * recorded — the button's label. Keyed on the IST date so the prediction cannot
 * survive midnight in the cache.
 */
export function useSelfPunchState(enabled = true): UseQueryResult<SelfPunchState, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.attendance.detail(`self-punch:state:${employeeId ?? NO_EMPLOYEE}:${istToday()}`),
    queryFn: ({ signal }) => fetchSelfPunchState(requireEmployeeId(employeeId), signal),
    enabled: enabled && employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/**
 * Send the punch. `selfPunch` resolves with refusals rather than throwing, so
 * `onSuccess` covers every settled outcome — including the ones that did not
 * record anything, which is why the invalidation is unconditional: after a
 * refusal the state read is still worth refreshing (the punch may have landed
 * and been replayed).
 *
 * `retry: false` is deliberate. This is a biometric write with an idempotency
 * key; an automatic retry would re-run a face match the audit log records, and
 * the employee — who is standing there — decides whether to try again.
 */
export function useSelfPunch(): UseMutationResult<SelfPunchOutcome, Error, SelfPunchRequest> {
  const queryClient = useQueryClient();
  const employeeId = useEmployeeId();
  return useMutation({
    mutationFn: (request: SelfPunchRequest) => selfPunch(request),
    retry: false,
    onSuccess: (outcome) => {
      /*
        The same tones the gate uses, from the same module, so an employee punching on their
        phone and the terminal at the door agree about what "recorded" sounds like.

        Mapped from `kind` rather than through `chimeForOutcome`, because this path's outcome is
        a discriminated union rather than the kiosk's flag object — and a refusal here is a
        SETTLED outcome that arrives through onSuccess (see the note above), so it must not be
        allowed to sound like a success.
      */
      playChime(
        outcome.kind === "recorded"
          ? "recorded"
          : outcome.kind === "already_recorded"
            ? "duplicate"
            : "error",
      );
      void queryClient.invalidateQueries({ queryKey: qk.attendance.all });
      if (employeeId === null) return;
      void queryClient.invalidateQueries({ queryKey: qk.home.today(employeeId, istToday()) });
      void queryClient.invalidateQueries({ queryKey: qk.home.monthStrip(employeeId) });
    },
  });
}
