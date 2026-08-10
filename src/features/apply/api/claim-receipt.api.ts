/**
 * claim-receipt.api.ts — attach the bill, and offer to read it.
 *
 * TWO JOBS, DELIBERATELY IN ONE FILE, because the second is meaningless without
 * the first: put the receipt in the vault (so the claim has evidence), then ask
 * the reader what it says (so the employee does not retype it).
 *
 * ── WHY THIS IMPORTS FROM THE PROFILE MODULE INSTEAD OF COPYING IT ────────────
 *
 * `storagePathFor` and `sha256Hex` come from `@/features/profile/api/documents.api`.
 * The sibling module in this feature copies `rupeesToPaise` rather than importing
 * it, with a note saying a self-service screen should not depend on an admin one
 * — and that reasoning does not carry here, for one specific reason:
 *
 *   `documents__own_write` requires the employee id to be the SECOND folder
 *   segment (`storage.foldername(name))[2]`). A second copy of that convention
 *   is a second thing that can be got subtly wrong, and getting it wrong means
 *   an upload that is refused — or worse, one that lands somewhere the policy
 *   did not intend. A security-load-bearing path convention should have exactly
 *   one implementation.
 *
 * Both modules are self-service and sit at the same level, so there is no
 * layering violation — only a shared rule with one owner.
 *
 * ── ORDER AND FAILURE ────────────────────────────────────────────────────────
 *
 * Bytes first, row second, exactly as `uploadProfileDocument` does and for the
 * same reason: `documents.storage_path` is NOT NULL, so a row pointing at bytes
 * that were never written is the worse artefact. A refused row leaves an orphan
 * object, which nothing serves and nobody can reach.
 */
import { z } from "zod";
import {
  DOCUMENTS_TABLE,
  DOCUMENT_TYPES_TABLE,
  insertedDocumentSchema,
  type InsertedDocument,
  PROFILE_DOCUMENT_BUCKET,
  sha256Hex,
  storagePathFor,
  uploadableDocumentTypeSchema,
  type UploadableDocumentType,
} from "@/features/profile/api/documents.api";
import { eq, isFalse, isNull, isTrue, QueryError, selectOne } from "@/shared/api/query";
import { insertOne } from "@/shared/api/write";
import { invokeEdgeFn, newIdempotencyKey } from "@/shared/api/invoke";
import { supabase } from "@/lib/supabase";
import { CLAIM_RECEIPT_TYPE_CODE } from "../claimPolicy";

const RECEIPT_TYPE_COLUMNS =
  "id, code, name, description, category, sub_category, requires_expiry, requires_approval, " +
  "is_sensitive, is_required_for_onboarding, allowed_mime_types, max_file_size_mb, " +
  "storage_bucket, sort_order";

/**
 * The receipt type, or null when this deployment has not got migration 040400.
 *
 * EVERY PREDICATE OF `documents__self__insert` IS RESTATED, for the reason the
 * profile picker learned the hard way: a type fetched without them can be
 * offered, filled in, and only then refused by the database. Null here means the
 * screen must say the receipt cannot be attached — before anyone chooses a file.
 */
export function fetchClaimReceiptType(
  signal?: AbortSignal,
): Promise<UploadableDocumentType | null> {
  return selectOne(
    DOCUMENT_TYPES_TABLE,
    uploadableDocumentTypeSchema,
    [
      eq("code", CLAIM_RECEIPT_TYPE_CODE),
      isTrue("is_active"),
      isNull("deleted_at"),
      isTrue("visible_to_employee"),
      isTrue("employee_uploadable"),
      isFalse("requires_esign"),
      isFalse("requires_acknowledgement"),
    ],
    { columns: RECEIPT_TYPE_COLUMNS, ...(signal ? { signal } : {}) },
  );
}

export interface UploadClaimReceiptInput {
  readonly employeeId: string;
  readonly companyId: string;
  /** `profiles.id` — `documents.uploaded_by` references profiles, not auth.users. */
  readonly profileId: string;
  readonly type: UploadableDocumentType;
  readonly file: File;
  /**
   * What the file actually is, sniffed from its first bytes.
   *
   * NOT `file.type`: that is the browser's guess from the file NAME, and a PDF
   * saved as `invoice.pdf -10-Aug-2026.pdf-ish` arrives with an empty type. The
   * row would then say `application/octet-stream` and the reader — which
   * branches on the STORED mime — would refuse a file it could have read.
   */
  readonly mimeType: string;
  /** The bill's own date when the employee has already typed one; else null. */
  readonly issueDate: string | null;
}

export async function uploadClaimReceipt(
  input: UploadClaimReceiptInput,
): Promise<InsertedDocument> {
  const checksum = await sha256Hex(input.file);
  const path = storagePathFor(input.employeeId, input.type.code, input.file.name);
  const mime = input.mimeType === "" ? "application/octet-stream" : input.mimeType;

  const uploaded = await supabase.storage
    .from(PROFILE_DOCUMENT_BUCKET)
    .upload(path, input.file, { contentType: mime, upsert: false });
  if (uploaded.error) {
    throw new QueryError(
      `storage/${PROFILE_DOCUMENT_BUCKET}`,
      "no_permission",
      uploaded.error.message,
      { cause: uploaded.error },
    );
  }

  try {
    return await insertOne(
      DOCUMENTS_TABLE,
      insertedDocumentSchema,
      {
        document_type_id: input.type.id,
        company_id: input.companyId,
        subject_kind: "employee",
        employee_id: input.employeeId,
        title: `Receipt — ${input.file.name}`,
        file_name: input.file.name,
        storage_bucket: PROFILE_DOCUMENT_BUCKET,
        storage_path: path,
        mime_type: mime,
        file_size_bytes: input.file.size,
        checksum_sha256: checksum,
        current_version: 1,
        // Same expression the policy enforces. EXPENSE_RECEIPT is seeded with
        // requires_approval false, so a receipt lands `approved` and is not put
        // in HR's review queue — the approval that matters is the claim's, taken
        // by someone looking at the bill and the amount together.
        status: input.type.requires_approval ? "pending_review" : "approved",
        virus_scan_status: "pending",
        is_system_generated: false,
        is_confidential: false,
        requires_acknowledgement: false,
        uploaded_by: input.profileId,
        issue_date: input.issueDate,
        expiry_date: null,
        tags: ["employee-upload", "claim-receipt"],
        source_reference: { uploaded_from: "/me/apply/claim" },
      },
      { columns: "id, title, status" },
    );
  } catch (error) {
    // Expected to fail — 039 grants an employee INSERT and no DELETE — and its
    // failure must never replace the real reason the row was refused.
    try {
      await supabase.storage.from(PROFILE_DOCUMENT_BUCKET).remove([path]);
    } catch {
      // Deliberately swallowed.
    }
    throw error;
  }
}

// -----------------------------------------------------------------------------
// Reading it
// -----------------------------------------------------------------------------

export const CLAIM_RECEIPT_EXTRACT_FN = "claim-receipt-extract";

/**
 * What the reader found. Any field may be null, and null means NOT READ — never
 * "read as empty": the function blanks anything it was not confident about
 * before replying, so a value present here is one it stood behind.
 */
export const extractedReceiptSchema = z.object({
  document_id: z.string(),
  fields: z.object({
    total_amount_rupees: z.number().nullable(),
    bill_date: z.string().nullable(),
    vendor_name: z.string().nullable(),
    gst_number: z.string().nullable(),
    description: z.string().nullable(),
    travel_mode: z.string().nullable(),
  }),
  confidence: z.object({
    total_amount_rupees: z.number(),
    bill_date: z.number(),
    vendor_name: z.number(),
    gst_number: z.number(),
    description: z.number(),
    travel_mode: z.number(),
  }),
  notes: z.string(),
  cost_inr: z.number().optional(),
  model: z.string().optional(),
});
export type ExtractedReceipt = z.infer<typeof extractedReceiptSchema>;

/**
 * Ask the reader what the bill says.
 *
 * THE CALLER MUST TREAT EVERY FAILURE AS "TYPE IT IN YOURSELF". Reading is a
 * convenience on top of a claim that is already valid without it: the bytes are
 * already in the vault and the form already works. A budget that has run out, a
 * blurred photo and a model that refused are all the same outcome from the
 * employee's side, and none of them is a reason to block the claim.
 *
 * A fresh idempotency key per call on purpose — re-reading the same receipt is a
 * legitimate retry, not a duplicate write, and it writes nothing but a ledger
 * row.
 */
export function extractClaimReceipt(
  documentId: string,
  signal?: AbortSignal,
): Promise<ExtractedReceipt> {
  return invokeEdgeFn(
    CLAIM_RECEIPT_EXTRACT_FN,
    { document_id: documentId },
    extractedReceiptSchema,
    { idempotencyKey: newIdempotencyKey(), ...(signal ? { signal } : {}) },
  );
}
