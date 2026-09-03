/**
 * attendanceProof.api.ts — the photograph that goes with an off-hours punch.
 *
 * ── WHAT IT IS FOR ─────────────────────────────────────────────────────────
 * The venue's instruction: "Can we give one small screenshot or something for records,
 * evidence?" — "Mandatory, yes. They should attach. And while checking out also, it's
 * mandatory. Someone will check in and the meeting would have been over long back. They might
 * check out by 10 or 12 o'clock. I don't want to pay so much and I don't want to keep on
 * verifying all that."
 *
 * So a punch taken outside the shift window carries a picture as well as a reason: the meeting
 * invitation, the call window, or the place of work. A gate punch carries neither — the camera
 * at the door already saw who it was.
 *
 * ── WHY IT MIRRORS THE CLAIM RECEIPT RATHER THAN INVENTING A PATH ───────────
 * `storagePathFor` and `sha256Hex` come from the profile documents module for the reason its
 * sibling states: `documents__self__insert` requires the employee id to be the SECOND folder
 * segment, and a security-load-bearing path convention must have exactly one implementation.
 * A second copy is a second thing to get subtly wrong, and getting it wrong means bytes
 * landing somewhere the policy did not intend.
 *
 * ── BYTES FIRST, ROW SECOND ────────────────────────────────────────────────
 * `documents.storage_path` is NOT NULL, so a row pointing at bytes that were never written is
 * the worse artefact. A refused row leaves an orphan object, which nothing serves and nobody
 * can reach — and it is cleaned up below on the way out.
 */
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
import { supabase } from "@/lib/supabase";

/** Seeded by migration 20260903180000. */
export const ATTENDANCE_PROOF_TYPE_CODE = "ATTENDANCE_PROOF";

const TYPE_COLUMNS =
  "id, code, name, description, category, sub_category, requires_expiry, requires_approval, " +
  "is_sensitive, is_required_for_onboarding, allowed_mime_types, max_file_size_mb, " +
  "storage_bucket, sort_order";

/**
 * The proof type, or null when this deployment has not got the migration.
 *
 * EVERY PREDICATE OF `documents__self__insert` IS RESTATED, for the reason the profile picker
 * learned the hard way: a type fetched without them can be offered, filled in, and only then
 * refused by the database. Null here means the card must say the photograph cannot be attached
 * — BEFORE anybody chooses a file, not after.
 */
export function fetchAttendanceProofType(
  signal?: AbortSignal,
): Promise<UploadableDocumentType | null> {
  return selectOne(
    DOCUMENT_TYPES_TABLE,
    uploadableDocumentTypeSchema,
    [
      eq("code", ATTENDANCE_PROOF_TYPE_CODE),
      isTrue("is_active"),
      isNull("deleted_at"),
      isTrue("visible_to_employee"),
      isTrue("employee_uploadable"),
      isFalse("requires_esign"),
      isFalse("requires_acknowledgement"),
    ],
    { columns: TYPE_COLUMNS, ...(signal ? { signal } : {}) },
  );
}

export interface UploadAttendanceProofInput {
  readonly employeeId: string;
  readonly companyId: string;
  /** `profiles.id` — `documents.uploaded_by` references profiles, not auth.users. */
  readonly profileId: string;
  readonly type: UploadableDocumentType;
  readonly file: File;
  /**
   * What the file actually is, sniffed from its first bytes.
   *
   * NOT `file.type`: that is the browser's guess from the NAME, and a photograph shared out of
   * a chat app often arrives with an empty type. The row would then read
   * `application/octet-stream` and an admin's viewer would refuse to render an image it could
   * have shown.
   */
  readonly mimeType: string;
}

export async function uploadAttendanceProof(
  input: UploadAttendanceProofInput,
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
        title: `Attendance proof — ${input.file.name}`,
        file_name: input.file.name,
        storage_bucket: PROFILE_DOCUMENT_BUCKET,
        storage_path: path,
        mime_type: mime,
        file_size_bytes: input.file.size,
        checksum_sha256: checksum,
        current_version: 1,
        /*
          The same expression the policy enforces. ATTENDANCE_PROOF is seeded
          `requires_approval = false`, so the photograph lands `approved` and is not put in
          HR's document queue — the approval that matters is the PUNCH's, taken by somebody
          looking at the picture and the hours together.
        */
        status: input.type.requires_approval ? "pending_review" : "approved",
        virus_scan_status: "pending",
        is_system_generated: false,
        /*
          Marked confidential: it is a photograph of where somebody was, taken outside working
          hours. It should not surface in the general document browser alongside their PAN card.
        */
        is_confidential: true,
        requires_acknowledgement: false,
        uploaded_by: input.profileId,
        issue_date: null,
        expiry_date: null,
        tags: ["employee-upload", "attendance-proof"],
        source_reference: { uploaded_from: "/me/attendance" },
      },
      { columns: "id, title, status" },
    );
  } catch (error) {
    // Expected to fail — 039 grants an employee INSERT and no DELETE — and its failure must
    // never replace the real reason the row was refused.
    try {
      await supabase.storage.from(PROFILE_DOCUMENT_BUCKET).remove([path]);
    } catch {
      // Deliberately swallowed.
    }
    throw error;
  }
}
