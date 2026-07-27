/**
 * claim-submit.api.ts — the ONE request on the four E-10 screens that the
 * deployed backend can actually accept: a local expense claim.
 *
 * Why this one and not the other three, verified in the migrations:
 *
 *  * `reimbursement_claims` EXISTS (024 §1) and grants the employee the write:
 *    `rc__self__insert` (`employee_id = app.current_employee_id() AND status IN
 *    ('draft','pending')`) plus `GRANT SELECT, INSERT, UPDATE … TO
 *    authenticated`. `claim_lines` inherits the same audience through
 *    `claim_lines__self__insert`.
 *  * The reference is SERVER-MINTED: `trg_rc__claim_number` runs
 *    `public.generate_claim_number()` (CLM-<IST year>-<6 digits>) before every
 *    insert. Nothing here invents a claim number.
 *  * `LOCAL_CLAIM` is the one of these four request types with approval chains
 *    seeded (046 §3: `AC-CLAIM-SMALL` ≤ ₹10,000 → reporting manager;
 *    `AC-CLAIM-LARGE` > ₹10,000 → manager → finance → super admin), so
 *    `create_approval_request` can resolve a chain instead of raising.
 *  * The table is NOT in `audit.reason_required_tables` (006 §1 lists 17 tables;
 *    this is not one), so the self-service `insertOne`/`updateOne` path applies
 *    and no `x-reason` header is required. Nothing is silently reason-less: the
 *    workflow engine writes its own `approval_actions` row for the submission.
 *
 * TWO UNIT SYSTEMS, BOTH THE SERVER'S, NEITHER CONVERTED BY ARITHMETIC HERE:
 *   `reimbursement_claims.total_claimed_paise` / `claim_lines.amount_claimed_paise`
 *   are integer PAISE (024 header), while `approval_requests.amount` — the
 *   column the chain thresholds are compared against — is `numeric(14,2)` RUPEES
 *   (046 seeds 10000, i.e. ₹10,000). The employee types ONE figure in rupees;
 *   `rupeesToPaise` encodes it for the paise columns by string arithmetic on the
 *   two halves, and the same typed figure goes to the RPC as rupees. No amount
 *   is divided, multiplied or rounded to produce a different one.
 *
 * WHAT THE SERVER DOES NOT DO, AND THE SCREEN THEREFORE SAYS: `act_on_approval`
 * (029 §11) writes `approval_requests` and `approval_actions` only — it never
 * touches a detail table. So an approved claim's `reimbursement_claims.status`
 * stays `pending` and its `total_approved_paise` stays NULL until Finance edits
 * the row. The decision of record lives on the approval request, which is what
 * `OpenRequestsGrid` shows.
 */
import { z } from "zod";
import {
  dbDateNullable,
  dbIntNullable,
  dbTimestamp,
  dbUuid,
  dbUuidNullable,
  eq,
  rpcOne,
  selectMany,
  selectOne,
} from "@/shared/api/query";
import { insertOne, updateOne } from "@/shared/api/write";
import { approvalStatusSchema, APPROVAL_REQUESTS_TABLE } from "./apply.api";
import { CREATE_APPROVAL_REQUEST_FN, REQUEST_CODE_LOCAL_CLAIM } from "./apply-requests.api";

export const REIMBURSEMENT_CLAIMS_TABLE = "reimbursement_claims";
export const CLAIM_LINES_TABLE = "claim_lines";

/**
 * `ck_rc__claim_type` (024 §1) — the database's own enumerated domain for a
 * claim head. Listed here for the same reason `approvalStatusSchema` lists
 * `public.approval_status`: a CHECK constraint is a closed vocabulary, and a
 * select built from it cannot offer a value the insert would reject.
 */
export const claimTypeValues = [
  "local_conveyance",
  "travel",
  "food",
  "medical",
  "telephone",
  "uniform",
  "fuel",
  "guest_hospitality",
  "misc",
] as const;
export const claimTypeSchema = z.enum(claimTypeValues);
export type ClaimType = z.infer<typeof claimTypeSchema>;

/**
 * Parse the rupee figure the employee typed into integer paise. String
 * arithmetic on the two halves — never a float multiply, so ₹1,234.56 cannot
 * become 123455.99999. Encoding an input, not computing a total.
 *
 * Same implementation as the Stores console's (`admin/api/assets.api.ts`); it is
 * repeated rather than imported so a self-service screen does not depend on an
 * admin module.
 */
export function rupeesToPaise(rupees: string): number | null {
  const trimmed = rupees.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const parts = trimmed.split(".");
  const whole = parts[0] ?? "0";
  const frac = ((parts[1] ?? "") + "00").slice(0, 2);
  return Number(whole) * 100 + Number(frac);
}

/** The rupee figure as a number, for `approval_requests.amount` (rupees). */
export function rupeesAsNumber(rupees: string): number | null {
  const trimmed = rupees.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  return Number(trimmed);
}

// -----------------------------------------------------------------------------
// My claims
// -----------------------------------------------------------------------------

export const claimRowSchema = z.object({
  id: dbUuid,
  /** Server-minted by `generate_claim_number()`. */
  claim_number: z.string(),
  claim_type: claimTypeSchema,
  claim_kind: z.string(),
  period_from: dbDateNullable,
  period_to: dbDateNullable,
  /** Integer paise. */
  total_claimed_paise: dbIntNullable,
  /** Integer paise; NULL until Finance settles the claim. */
  total_approved_paise: dbIntNullable,
  status: approvalStatusSchema,
  approval_request_id: dbUuidNullable,
  event_reference: z.string().nullable(),
  paid_on: dbDateNullable,
  created_at: dbTimestamp,
});
export type ClaimRow = z.infer<typeof claimRowSchema>;

const CLAIM_COLUMNS =
  "id, claim_number, claim_type, claim_kind, period_from, period_to, total_claimed_paise, " +
  "total_approved_paise, status, approval_request_id, event_reference, paid_on, created_at";

const MY_CLAIMS_CAP = 50;

/** My own claims, newest first. `rc__self__select` is the boundary. */
export function fetchMyClaims(employeeId: string, signal?: AbortSignal): Promise<ClaimRow[]> {
  return selectMany(REIMBURSEMENT_CLAIMS_TABLE, claimRowSchema, {
    columns: CLAIM_COLUMNS,
    filters: [eq("employee_id", employeeId)],
    order: [{ column: "created_at", ascending: false }],
    limit: MY_CLAIMS_CAP,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// Submit
// -----------------------------------------------------------------------------

export interface SubmitClaimInput {
  readonly employeeId: string;
  readonly claimType: ClaimType;
  /** YYYY-MM-DD — the day (or first day) the expense was incurred. */
  readonly periodFrom: string;
  readonly periodTo: string;
  /** Exactly what the employee typed, e.g. '1250' or '1250.50'. */
  readonly amountRupees: string;
  readonly description: string;
  /** The wedding/event this was incurred for. Venue reality, `event_reference`. */
  readonly eventReference: string | null;
  /** `request_types.requires_attachment` for LOCAL_CLAIM — a server fact. */
  readonly receiptRequired: boolean;
}

export interface SubmittedClaim {
  readonly claim: ClaimRow;
  readonly requestId: string;
  /** `approval_requests.request_number`, e.g. `LOCAL_CLAIM-000031`. */
  readonly requestNumber: string | null;
}

const requestRefSchema = z.object({ id: dbUuid, request_number: z.string() });

const claimIdentitySchema = claimRowSchema.pick({
  id: true,
  claim_number: true,
  status: true,
});

/**
 * claim row → claim line → approval request → back-link, in that order.
 *
 * The order is forced by the database, not chosen: `approval_requests.detail_id`
 * is `NOT NULL`, so the claim must exist before the request can point at it. If
 * step 3 fails the claim survives as a `pending` row the employee can see and
 * resubmit — the opposite arrangement would leave an approval request pointing
 * at nothing.
 */
export async function submitLocalClaim(
  input: SubmitClaimInput,
  signal?: AbortSignal,
): Promise<SubmittedClaim> {
  const paise = rupeesToPaise(input.amountRupees);
  const rupees = rupeesAsNumber(input.amountRupees);
  if (paise === null || rupees === null) {
    throw new Error("The amount must be a rupee figure with at most two decimals.");
  }
  const description = input.description.trim();
  const event = input.eventReference === null ? null : input.eventReference.trim();

  // 1. The claim itself. `claim_number` is omitted on purpose: the BEFORE INSERT
  //    trigger mints it. `status: 'pending'` is the only non-draft state
  //    `rc__self__insert` permits.
  const claim = await insertOne(
    REIMBURSEMENT_CLAIMS_TABLE,
    claimRowSchema,
    {
      employee_id: input.employeeId,
      claim_type: input.claimType,
      claim_kind: "local_claim",
      period_from: input.periodFrom,
      period_to: input.periodTo,
      total_claimed_paise: paise,
      status: "pending",
      event_reference: event === "" ? null : event,
    },
    { columns: CLAIM_COLUMNS, ...(signal ? { signal } : {}) },
  );

  // 2. ONE line, carrying the same single figure the employee typed. A
  //    multi-line claim would need `total_claimed_paise` to equal the sum of its
  //    lines, and no trigger maintains that sum — adding it up in the browser is
  //    exactly the client-side arithmetic this codebase forbids.
  await insertOne(
    CLAIM_LINES_TABLE,
    z.object({ id: dbUuid }),
    {
      claim_id: claim.id,
      line_date: input.periodFrom,
      expense_head: input.claimType,
      description,
      amount_claimed_paise: paise,
      is_receipt_required: input.receiptRequired,
    },
    { columns: "id", ...(signal ? { signal } : {}) },
  );

  // 3. Into the workflow engine. `p_amount` is RUPEES — it is what the chain
  //    thresholds are compared against; the engine picks the chain, resolves the
  //    approvers and mints `request_number`.
  const requestId = await rpcOne(
    CREATE_APPROVAL_REQUEST_FN,
    {
      p_request_type_code: REQUEST_CODE_LOCAL_CLAIM,
      p_subject_employee_id: input.employeeId,
      p_detail_id: claim.id,
      p_title: `${claim.claim_number} · ${input.claimType}`,
      p_summary: {
        summary: description,
        claim_number: claim.claim_number,
        claim_type: input.claimType,
        event_reference: event === "" ? null : event,
        period_from: input.periodFrom,
        period_to: input.periodTo,
      },
      p_amount: rupees,
      p_days: null,
      p_priority: "normal",
      p_on_behalf_of: null,
    },
    dbUuid,
    signal ? { signal } : {},
  );
  if (requestId === null) {
    throw new Error("The claim was saved but the approval request was not created.");
  }

  // 4. Back-link, so Finance opening the claim can reach its decision trail.
  //    `rc__self__update` permits it while the claim is still `pending`.
  const linked = await updateOne(
    REIMBURSEMENT_CLAIMS_TABLE,
    claimIdentitySchema,
    { approval_request_id: requestId },
    { id: claim.id },
    { columns: "id, claim_number, status", ...(signal ? { signal } : {}) },
  );

  const ref = await selectOne(APPROVAL_REQUESTS_TABLE, requestRefSchema, [eq("id", requestId)], {
    columns: "id, request_number",
    ...(signal ? { signal } : {}),
  });

  return {
    claim: { ...claim, id: linked.id, approval_request_id: requestId },
    requestId,
    requestNumber: ref?.request_number ?? null,
  };
}
