/**
 * useFaceLogin — read and flip the face SIGN-IN switch.
 *
 * One hook pair serves all three audiences, because the DATABASE decides scope: the
 * view returns self for an employee, self plus reportees for a manager, and everyone
 * in scope for an admin. There is no per-role hook, and deliberately so — three hooks
 * would be three places for the scope rule to be re-stated and got wrong.
 *
 * ON FAILURE THE SWITCH SNAPS BACK. There is no optimistic update. A refusal here is
 * a 42501 from `set_face_login_enabled`, which means the caller may not change that
 * person — and a control that showed "off" for a second before reverting would read as
 * "it worked, then something undid it". The mutation resolves to the value the database
 * settled on and the cache is set from THAT, so what is on screen is what is stored.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { shouldRetryQuery } from "@/shared/api/query";
import {
  fetchFaceLoginAccess,
  setFaceLoginEnabled,
  type FaceLoginAccess,
} from "../api/faceLogin.api";

/** Scoped by the caller's own identity, so it must not be shared across sessions. */
const KEY = ["settings", "face-login-access"] as const;

export function useFaceLoginAccess(
  employeeIds?: readonly string[],
): UseQueryResult<FaceLoginAccess[], Error> {
  return useQuery({
    queryKey: [...KEY, employeeIds === undefined ? "mine" : [...employeeIds].sort()],
    queryFn: ({ signal }) => fetchFaceLoginAccess(employeeIds, signal),
    retry: shouldRetryQuery,
  });
}

export interface FaceLoginToggleInput {
  readonly employeeId: string;
  readonly enabled: boolean;
}

export function useSetFaceLogin(onDone?: (enabled: boolean) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeId, enabled }: FaceLoginToggleInput) =>
      setFaceLoginEnabled(employeeId, enabled),
    onSuccess: (stored, input) => {
      /*
        Write the DATABASE's answer into every cached row for that employee rather
        than the value we asked for. They agree today; if a future trigger ever
        overrides the request, the screen will show what is actually stored instead of
        quietly disagreeing with it.
      */
      qc.setQueriesData<FaceLoginAccess[]>({ queryKey: KEY }, (rows) =>
        rows?.map((row) =>
          row.employee_id === input.employeeId ? { ...row, allow_face_login: stored } : row,
        ),
      );
      // The sign-in method picker reads eligibility separately; let it re-ask.
      void qc.invalidateQueries({ queryKey: ["auth"] });
      onDone?.(stored);
    },
  });
}
