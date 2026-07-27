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
import { inList, selectMany, shouldRetryQuery } from "@/shared/api/query";
import { qk } from "@/shared/api/keys";

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
  signal?: AbortSignal,
): Promise<FaceEnrolmentAsk | null> {
  const rows = await selectMany(FACE_ENROLMENT_REQUESTS_TABLE, faceEnrolmentAskSchema, {
    filters: [inList("status", [...OPEN_STATUSES])],
    order: [{ column: "requested_at", ascending: false }],
    columns: COLUMNS,
    limit: 1,
    ...(signal ? { signal } : {}),
  });
  return rows[0] ?? null;
}

export function useMyFaceEnrolmentAsk(): UseQueryResult<FaceEnrolmentAsk | null, Error> {
  return useQuery({
    queryKey: qk.home.faceEnrolmentAsk(),
    queryFn: ({ signal }) => fetchMyFaceEnrolmentAsk(signal),
    retry: shouldRetryQuery,
  });
}
