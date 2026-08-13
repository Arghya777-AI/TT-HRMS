/**
 * certification.api.ts — funding a professional certification.
 *
 * ── THE ONE GAP THAT WAS REAL ────────────────────────────────────────────────
 *
 * /me/apply/certification listed five things that did not exist — a request type,
 * a detail table, an approval chain, the catalogue, and a claim head to spend
 * against — and unlike the asset and tax screens, every one of those five was
 * true. Migration 043300 built all of them. This is the client half.
 *
 * ── TWO NUMBERS, NOT ONE ─────────────────────────────────────────────────────
 *
 * A claim carries the COURSE FEE and the AMOUNT ASKED FOR, and they differ
 * whenever a catalogue cap bites or the employee is funding part of it
 * themselves. Collapsing them to one figure would hide which of those two is
 * happening — and the difference is precisely what an approver needs to see. The
 * database refuses a request larger than the fee (`ck_certclaim__not_more_than_fee`)
 * and permits a smaller one, because asking for half of a course you are
 * part-funding is a normal thing to do.
 *
 * ── THE CATALOGUE IS AN OFFER, NOT A GATE ────────────────────────────────────
 *
 * `catalogue_id` is nullable on purpose. Somebody will always want a course
 * nobody has listed, and refusing to record it just pushes the request back onto
 * WhatsApp where nothing can approve it. A claim with no catalogue row is an ASK;
 * the approver decides, and if enough of them say yes the catalogue gains a row.
 *
 * The cap is therefore shown, never enforced here. It is what the venue has
 * agreed to fund — not a limit on what may be typed.
 */
import { z } from "zod";
import {
  dbDateNullable,
  dbInt,
  dbIntNullable,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  isTrue,
  selectMany,
} from "@/shared/api/query";
import { REQUEST_CODE_CERTIFICATION } from "./apply-requests.api";
import { raiseSimpleRequest } from "./simple-requests.api";

export const CERTIFICATION_CATALOGUE_TABLE = "certification_catalogue";
export const CERTIFICATION_CLAIMS_TABLE = "certification_claims";

export { REQUEST_CODE_CERTIFICATION };

/** `ck_certcat__category` — a closed vocabulary, restated. */
export const certificationCategoryValues = [
  "professional",
  "safety",
  "hospitality",
  "culinary",
  "compliance",
  "language",
  "other",
] as const;
export type CertificationCategory = (typeof certificationCategoryValues)[number];

/**
 * `ck_certclaim__commitment` — 1 to 60 months, or none at all.
 *
 * Recorded at approval and never enforced by a trigger: clawing money back from
 * somebody who leaves is a decision with a conversation attached, not a job for
 * a constraint.
 */
export const SERVICE_COMMITMENT_MIN_MONTHS = 1;
export const SERVICE_COMMITMENT_MAX_MONTHS = 60;

/** `ck_certclaim__reason` — the server counts trimmed characters, so this does too. */
export const CERTIFICATION_REASON_MIN_LENGTH = 15;

export const certificationCatalogueSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  issuing_body: z.string().nullable(),
  category: z.string(),
  /** The CEILING the venue funds — not the price of the course. */
  funding_cap_paise: dbInt,
  eligibility_note: z.string().nullable(),
  requires_pass: z.boolean(),
  is_active: z.boolean(),
});
export type CertificationCatalogueEntry = z.infer<typeof certificationCatalogueSchema>;

export const certificationClaimSchema = z.object({
  id: dbUuid,
  catalogue_id: dbUuidNullable,
  certification_name: z.string(),
  issuing_body: z.string().nullable(),
  course_fee_paise: dbInt,
  amount_requested_paise: dbInt,
  amount_approved_paise: dbIntNullable,
  starts_on: dbDateNullable,
  completes_on: dbDateNullable,
  reason: z.string(),
  service_commitment_months: dbIntNullable,
  status: z.string(),
  approval_request_id: dbUuidNullable,
  submitted_at: dbTimestampNullable,
  decided_at: dbTimestampNullable,
  decided_comment: z.string().nullable(),
  reimbursed_on: dbDateNullable,
  reimbursement_reference: z.string().nullable(),
  created_at: dbTimestamp,
});
export type CertificationClaim = z.infer<typeof certificationClaimSchema>;

const CATALOGUE_COLUMNS =
  "id, code, name, issuing_body, category, funding_cap_paise, eligibility_note, " +
  "requires_pass, is_active";

const CLAIM_COLUMNS =
  "id, catalogue_id, certification_name, issuing_body, course_fee_paise, " +
  "amount_requested_paise, amount_approved_paise, starts_on, completes_on, reason, " +
  "service_commitment_months, status, approval_request_id, submitted_at, decided_at, " +
  "decided_comment, reimbursed_on, reimbursement_reference, created_at";

/**
 * What the venue has agreed to fund.
 *
 * Active rows only — `certcat__read` shows an admin the inactive ones too, and a
 * withdrawn offer appearing in an employee's picker would be an offer the venue
 * has stopped making.
 */
export function fetchCertificationCatalogue(
  signal?: AbortSignal,
): Promise<CertificationCatalogueEntry[]> {
  return selectMany(CERTIFICATION_CATALOGUE_TABLE, certificationCatalogueSchema, {
    columns: CATALOGUE_COLUMNS,
    filters: [isTrue("is_active")],
    order: [
      { column: "category", ascending: true },
      { column: "name", ascending: true },
    ],
    ...(signal ? { signal } : {}),
  });
}

/** My own claims, newest first. RLS narrows this to me; the filter is belt and braces. */
export function fetchMyCertificationClaims(
  employeeId: string,
  signal?: AbortSignal,
): Promise<CertificationClaim[]> {
  return selectMany(CERTIFICATION_CLAIMS_TABLE, certificationClaimSchema, {
    columns: CLAIM_COLUMNS,
    filters: [eq("employee_id", employeeId)],
    order: [{ column: "created_at", ascending: false }],
    limit: 50,
    ...(signal ? { signal } : {}),
  });
}

export interface SubmitCertificationClaimInput {
  readonly employeeId: string;
  /** Null when the course is not in the catalogue — an ask, not an error. */
  readonly catalogueId: string | null;
  readonly certificationName: string;
  readonly issuingBody: string | null;
  readonly courseFeePaise: number;
  readonly amountRequestedPaise: number;
  /** Rupees, for `approval_requests.amount` — the chain reads that, not paise. */
  readonly amountRequestedRupees: number;
  readonly startsOn: string | null;
  readonly completesOn: string | null;
  readonly reason: string;
}

/**
 * Insert the claim, then raise its approval.
 *
 * `status: 'pending'` on the insert is what fires `trg_certclaim__raise_approval`
 * server-side — but the shared four-step sequence is used anyway, because the
 * trigger only runs on an UPDATE OF status and an insert that arrives already
 * pending would never trip it. Doing it explicitly means the approval request id
 * comes back here, so the screen can show the reference instead of hoping.
 */
export function submitCertificationClaim(
  input: SubmitCertificationClaimInput,
  signal?: AbortSignal,
): Promise<{ detailId: string; requestId: string }> {
  return raiseSimpleRequest({
    table: CERTIFICATION_CLAIMS_TABLE,
    row: {
      employee_id: input.employeeId,
      catalogue_id: input.catalogueId,
      certification_name: input.certificationName.trim(),
      issuing_body: input.issuingBody === null ? null : input.issuingBody.trim(),
      course_fee_paise: input.courseFeePaise,
      amount_requested_paise: input.amountRequestedPaise,
      starts_on: input.startsOn,
      completes_on: input.completesOn,
      reason: input.reason.trim(),
      status: "pending",
    },
    requestCode: REQUEST_CODE_CERTIFICATION,
    employeeId: input.employeeId,
    title: `Certification · ${input.certificationName.trim()}`,
    summary: {
      summary: input.reason.trim(),
      certification: input.certificationName.trim(),
      issuing_body: input.issuingBody,
      course_fee_paise: input.courseFeePaise,
      amount_requested_paise: input.amountRequestedPaise,
      starts_on: input.startsOn,
      completes_on: input.completesOn,
      /* Stated so an approver can see at a glance whether this is a listed
         offer or a request for something nobody has agreed to fund yet. */
      from_catalogue: input.catalogueId !== null,
    },
    amountRupees: input.amountRequestedRupees,
    signal,
  });
}

/**
 * The statuses in which a claim is still the employee's to withdraw.
 *
 * Mirrors `certclaim__self_update`'s USING clause. A decided claim is HR's
 * record, not a draft.
 */
export const CERTIFICATION_OPEN_STATUSES: readonly string[] = [
  "draft",
  "pending",
  "in_progress",
  "escalated",
];

/**
 * True when a second claim for this course would hit `uq_certclaim__one_open`.
 *
 * The index is over `lower(btrim(certification_name))` for open statuses only, so
 * a fresh attempt after a rejection is fine and two live ones are somebody
 * clicking twice. Matched here in the same terms, so the refusal arrives before
 * the round trip rather than as a unique-violation afterwards.
 */
export function hasOpenClaimFor(
  claims: readonly CertificationClaim[],
  certificationName: string,
): boolean {
  const key = certificationName.trim().toLowerCase();
  if (key === "") return false;
  return claims.some(
    (c) =>
      CERTIFICATION_OPEN_STATUSES.includes(c.status) &&
      c.certification_name.trim().toLowerCase() === key,
  );
}
