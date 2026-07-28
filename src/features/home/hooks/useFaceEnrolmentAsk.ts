/**
 * useFaceEnrolmentAsk — the employee's own open face-enrolment request.
 *
 * `face_enrolment_requests__self_select` (migration 012) is
 * `USING (employee_id = app.current_employee_id())`, so this reads exactly one
 * person's rows and needs no employee id passed in. RLS is the filter; the query
 * does not restate it, because a client-side predicate that disagrees with the
 * policy is how a "why can't I see my row" bug starts.
 *
 * `null` is the normal, common answer — nobody has asked. The card renders nothing
 * for it rather than a reassuring "no action needed", which is noise on a screen
 * people are meant to scan.
 *
 * Two open states matter and they mean different things to the employee:
 *   draft    — the admin has ASKED. The employee must go and be captured.
 *   pending  — a capture exists and is awaiting approval. Nothing left to do.
 * Anything decided (approved / rejected / cancelled / withdrawn) is not an open
 * ask and is excluded, so the card disappears once the work is done.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { z } from "zod";
import { eq, inList, selectMany, shouldRetryQuery } from "@/shared/api/query";
import { qk } from "@/shared/api/keys";
import { useAuth } from "@/app/auth/AuthProvider";

export const FACE_ENROLMENT_REQUESTS_TABLE = "face_enrolment_requests";

/** The two statuses that still need somebody to act. */
const OPEN_STATUSES = ["draft", "pending"] as const;

const faceEnrolmentAskSchema = z.object({
  id: z.string().uuid(),
  requested_at: z.string(),
  status: z.string(),
  requested_via: z.string(),
});

export type FaceEnrolmentAsk = z.infer<typeof faceEnrolmentAskSchema>;

const COLUMNS = "id, requested_at, status, requested_via";

export async function fetchMyFaceEnrolmentAsk(
  employeeId: string,
  signal?: AbortSignal,
): Promise<FaceEnrolmentAsk | null> {
  const rows = await selectMany(FACE_ENROLMENT_REQUESTS_TABLE, faceEnrolmentAskSchema, {
    /*
      THE EMPLOYEE FILTER IS THE FIX, AND ITS ABSENCE WAS A LEAK.

      This used to filter on STATUS ALONE and lean on RLS to mean "mine". For a plain
      employee that happened to be true, so it looked right. For an admin or a manager —
      who may legitimately read other people's rows — it returned the newest open request
      belonging to ANYBODY, and the home card presented it as "HR has asked YOU to register
      your face".

      Observed exactly that: a super-admin who was already enrolled saw a card dated
      28-Jul 22:49, which was Arjun Nair's draft request. Their own two requests were long
      since approved and applied. So the card was both wrong about the reader and showing
      them another employee's pending biometric request.

      RLS is a ceiling on what a query MAY return, never a statement of what it SHOULD.
      Anything that means "mine" has to say so.
    */
    filters: [eq("employee_id", employeeId), inList("status", [...OPEN_STATUSES])],
    order: [{ column: "requested_at", ascending: false }],
    columns: COLUMNS,
    limit: 1,
    ...(signal ? { signal } : {}),
  });
  return rows[0] ?? null;
}

export function useMyFaceEnrolmentAsk(): UseQueryResult<FaceEnrolmentAsk | null, Error> {
  const { employee } = useAuth();
  const employeeId = employee?.employeeId ?? null;
  return useQuery({
    // The id is part of the key: two accounts in one browser session must not share a
    // cached answer to "has HR asked ME to enrol".
    queryKey: [...qk.home.faceEnrolmentAsk(), employeeId],
    queryFn: ({ signal }) => fetchMyFaceEnrolmentAsk(employeeId ?? "", signal),
    // A profile with no employee record has no enrolment ask to show.
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}
