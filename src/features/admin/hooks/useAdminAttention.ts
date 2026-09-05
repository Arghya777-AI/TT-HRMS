/**
 * useAdminAttention — the seven queues behind "6 need your attention".
 *
 * Every figure is a server `HEAD … count=exact` over the same predicate as the screen it
 * opens, so the banner and its destination cannot disagree (DR-29). Nothing is summed in the
 * browser except the displayed rows themselves, which is the number in the sentence.
 *
 * A query that FAILED contributes `null`, not `0` — see `summariseAttention`. `isPending`
 * also reads as `null` so the banner does not flash "0 need your attention" and then correct
 * itself to six while the counts land.
 *
 * These run wherever the banner and the login popup are mounted, so they are deliberately the
 * cheap ones: seven counts on a five-minute refresh, no row bodies.
 */
import { ADMIN_ROUTES } from "../command-vocab";
import {
  summariseAttention,
  type AttentionKey,
  type AttentionSource,
  type AttentionSummary,
} from "../attention";
import {
  useAlertCount,
  useExpiringDocumentCount,
  useFaceAskCount,
  useFaceCaptureCount,
  useMyTaskCount,
  useOpenHelpdeskCount,
  usePunchReviewCount,
} from "./useCommandCentre";

type Count = { readonly data: number | undefined; readonly isSuccess: boolean };

/** Only a SUCCEEDED count is a number. Pending and failed are both "not known". */
function readable(q: Count): number | null {
  return q.isSuccess && q.data !== undefined ? q.data : null;
}

export interface AdminAttention extends AttentionSummary {
  /** True while nothing has resolved yet — the banner renders nothing rather than "0". */
  readonly isPending: boolean;
}

export function useAdminAttention(): AdminAttention {
  const approvals = useMyTaskCount();
  const alerts = useAlertCount({});
  const punchReview = usePunchReviewCount();
  const faceCaptures = useFaceCaptureCount();
  const helpdesk = useOpenHelpdeskCount();
  const faceAsks = useFaceAskCount();
  const documents = useExpiringDocumentCount();

  const queries = [approvals, alerts, punchReview, faceCaptures, helpdesk, faceAsks, documents];
  const isPending = queries.every((q) => !q.isSuccess);

  /* Not memoised: seven lookups and a reduce over at most seven rows, recomputed when React
     was going to re-render anyway. A `useMemo` here would have to depend on each query's
     `.data` and `.isSuccess` separately — the query objects are new every render — which is
     more moving parts than the work it saves. */
  const summary = summariseAttention([
    src("approvals", approvals, ADMIN_ROUTES.tasks),
    src("alerts", alerts, ADMIN_ROUTES.alerts),
    src("punchReview", punchReview, ADMIN_ROUTES.punchesToReview),
    src("faceCaptures", faceCaptures, ADMIN_ROUTES.kioskEnrolment),
    src("helpdesk", helpdesk, ADMIN_ROUTES.helpdesk),
    src("faceAsks", faceAsks, ADMIN_ROUTES.kioskEnrolment),
    src("documents", documents, ADMIN_ROUTES.documentExpiry),
  ]);

  return { ...summary, isPending };
}

function src(key: AttentionKey, q: Count, href: string): AttentionSource {
  return { key, count: readable(q), href };
}
