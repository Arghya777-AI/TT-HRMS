/**
 * useClaimEvidence.ts — the reads behind the attachment count and the evidence sheet.
 *
 * TWO HOOKS, SPLIT ON WHEN THEY ARE NEEDED:
 *
 *   useClaimLineEvidence   every visible claim's lines and receipts, fetched with the register
 *                          because the attachment COUNT belongs on the row. One request for
 *                          the page, never one per row: the register shows up to 500 claims.
 *
 *   useClaimAuditTrail     one claim's read trail and approval trail, fetched only when its
 *                          sheet opens. `document_access_log` holds 5,380 rows already, and
 *                          nothing justifies pulling a claim's slice of it for rows nobody has
 *                          opened.
 *
 * The split is also why the sheet is instant: it renders lines and receipts the register
 * already has, and streams the trail in underneath.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { fetchActorNames, type ActorProfile } from "../api/audit-registers.api";
import {
  attachReceipts,
  evidenceActorIds,
  fetchClaimApprovalActions,
  fetchClaimLines,
  fetchClaimReceipts,
  fetchReceiptAccessLog,
  groupLinesByClaim,
  tallyAttachments,
  type ClaimApprovalAction,
  type ClaimAttachmentTally,
  type ClaimLineWithReceipt,
  type ReceiptAccess,
} from "../api/claimEvidence.api";

export interface ClaimLineEvidence {
  /** Lines with their receipt, by `claim_id`. Absent key = that claim has no lines. */
  readonly byClaim: ReadonlyMap<string, ClaimLineWithReceipt[]>;
  /** The attachment tally per claim, for the register column. */
  readonly tallies: ReadonlyMap<string, ClaimAttachmentTally>;
}

const EMPTY: ClaimLineEvidence = { byClaim: new Map(), tallies: new Map() };

/**
 * Lines and receipts for the claims on screen.
 *
 * `claimIds` is sorted into the query key so the same set of claims in a different row order
 * is the same cache entry — the register re-sorts client-side, and re-fetching on a sort would
 * be a request for data already held.
 */
export function useClaimLineEvidence(
  claimIds: readonly string[],
): UseQueryResult<ClaimLineEvidence, Error> {
  const ids = [...claimIds].sort();
  return useQuery({
    queryKey: qk.admin.payslips({ part: "claim-lines", ids }),
    queryFn: async ({ signal }): Promise<ClaimLineEvidence> => {
      if (ids.length === 0) return EMPTY;
      const lines = await fetchClaimLines(ids, signal);
      const receipts = await fetchClaimReceipts(lines, signal);
      const byClaim = new Map<string, ClaimLineWithReceipt[]>();
      for (const [claimId, claimLines] of groupLinesByClaim(lines)) {
        byClaim.set(claimId, attachReceipts(claimLines, receipts));
      }
      const tallies = new Map<string, ClaimAttachmentTally>();
      for (const [claimId, rows] of byClaim) tallies.set(claimId, tallyAttachments(rows));
      return { byClaim, tallies };
    },
    retry: shouldRetryQuery,
  });
}

export interface ClaimAuditTrail {
  /** Every mint, view and download of this claim's receipts, newest first. */
  readonly access: readonly ReceiptAccess[];
  /** Every act on its approval request, oldest first — the order it happened in. */
  readonly actions: readonly ClaimApprovalAction[];
  /** `profiles.id` → name, for every actor either list mentions. */
  readonly actors: ReadonlyMap<string, ActorProfile>;
}

/**
 * One claim's full trail. Disabled until its sheet is open.
 *
 * `approvalRequestId` is nullable because a claim filed before the chain existed has none —
 * and that is not an error state, it is a claim with no approval trail to show.
 */
export function useClaimAuditTrail(
  claimId: string | null,
  approvalRequestId: string | null,
  lines: readonly ClaimLineWithReceipt[],
): UseQueryResult<ClaimAuditTrail, Error> {
  const documentIds = [...new Set(lines.flatMap(({ receipt }) => (receipt === null ? [] : [receipt.id])))].sort();
  return useQuery({
    queryKey: qk.admin.payslips({
      part: "claim-trail",
      claimId,
      approvalRequestId,
      documentIds,
    }),
    enabled: claimId !== null,
    queryFn: async ({ signal }): Promise<ClaimAuditTrail> => {
      const access = await fetchReceiptAccessLog(documentIds, signal);
      const actions =
        approvalRequestId === null ? [] : await fetchClaimApprovalActions([approvalRequestId], signal);
      const actors = await fetchActorNames(evidenceActorIds(lines, access, actions), signal);
      return { access, actions, actors };
    },
    retry: shouldRetryQuery,
  });
}
