/**
 * approvalEvidence.api.ts — the record behind an approval request, whatever type it is.
 *
 * ── WHY THE SHAPE IS OPEN ───────────────────────────────────────────────────
 * There are 19 request types over 13 detail tables, and HR's complaint was universal: "every
 * detail should be coming — images, what they applied for, what is the reason, and at what
 * time they applied. Right now only the times are coming." A leave request showed no reason,
 * and `leave_requests.supporting_document_id` had no reader anywhere in the app.
 *
 * So `fields` is deliberately `Record<string, unknown>` and NOT a per-type zod object. A
 * closed schema per table is 13 places to forget the reason column and a 14th type that ships
 * blank — which is the state being complained about. The server decides what a human should
 * see (`approval_request_evidence`, migration 20260903120000); this module carries it.
 *
 * The safety that a closed schema would have given is kept where it matters: `documents` is
 * parsed as uuids, `readable` as a boolean, and every VALUE is rendered through a formatter
 * that treats an unexpected type as text rather than trusting it.
 *
 * ── `readable: false` IS NOT AN EMPTY REQUEST ───────────────────────────────
 * It means the detail row exists — an approval this caller can read names it — and RLS did not
 * hand it over. Rendering that as "no details" tells an approver the employee submitted
 * nothing, which is the most misleading sentence available on a screen where money and
 * attendance get decided.
 */
import { z } from "zod";
import { dbUuid, rpcOne } from "@/shared/api/query";

export const APPROVAL_EVIDENCE_FN = "approval_request_evidence";

export const approvalEvidenceSchema = z.object({
  found: z.boolean(),
  readable: z.boolean().optional().default(false),
  detail_table: z.string().optional().nullable(),
  detail_id: dbUuid.optional().nullable(),
  /** Whatever the detail row holds, minus plumbing. Open by design — see the header. */
  fields: z.record(z.unknown()).optional().default({}),
  /** Child rows. Non-empty only for a reimbursement claim; every other table is flat. */
  lines: z.array(z.record(z.unknown())).optional().default([]),
  /** Every attachment on the row, deduplicated by the server. */
  documents: z.array(dbUuid).optional().default([]),
  /** A detail_table with no registered request type — a schema drift, said out loud. */
  unknown_table: z.boolean().optional().default(false),
});

export type ApprovalEvidence = z.infer<typeof approvalEvidenceSchema>;

/**
 * `approval_request_evidence` is SECURITY INVOKER, so this returns exactly what the signed-in
 * approver's own policies allow. There is no permission logic in this module and there must
 * never be: a second copy in TypeScript is how the two drift apart.
 */
export function fetchApprovalEvidence(
  approvalRequestId: string,
  signal?: AbortSignal,
): Promise<ApprovalEvidence | null> {
  return rpcOne(
    APPROVAL_EVIDENCE_FN,
    { p_approval_request_id: approvalRequestId },
    approvalEvidenceSchema,
    signal ? { signal } : {},
  );
}
