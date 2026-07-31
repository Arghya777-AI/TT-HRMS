/**
 * employee-documents.api.ts — an administrator attaching a document TO somebody else.
 *
 * WHY THIS DID NOT EXIST. There was exactly one upload path in the whole client
 * (`uploadProfileDocument`, an employee uploading their own), plus `document-generate`,
 * which renders a template and takes no file. So an admin holding a scan of somebody's
 * Aadhaar — handed over on paper at the desk, which is how it actually arrives at a venue
 * — had nowhere to put it. The only route was to ask the employee to log in and upload it
 * themselves, which is not a route on their first day.
 *
 * THREE THINGS DIFFER FROM THE SELF PATH, and each is deliberate.
 *
 * 1. `employee_id` is the SUBJECT, `uploaded_by` is the ADMIN. `documents.uploaded_by`
 *    references `profiles`, not `auth.users`, and it is the record of who put the file
 *    there — never the person it is about. Conflating them would credit an employee with
 *    an upload they did not make.
 *
 * 2. THE STATUS IS `approved`, AND THE REVIEW IS STAMPED TO THE ADMIN. The self path
 *    lands `pending_review` for types that `requires_approval`, because somebody has to
 *    check what the employee asserted. When HR is the one uploading, HR IS that somebody:
 *    leaving it pending would put an item in the review queue asking HR to approve their
 *    own upload, and a queue full of self-approvals is how a real mismatch gets waved
 *    through. So `reviewed_by`/`reviewed_at` record who vouched for it, which is more
 *    honest than a pending row nobody will read.
 *
 * 3. THE PATH SHAPE IS IDENTICAL ANYWAY. `documents__admin_all` is FOR ALL and pins no
 *    columns, so an admin COULD write any path — unlike the self policy, which migration
 *    021000 pins to `employee/<own id>/…`. Using the same shape is not required; it is
 *    required for everything downstream to behave the same, since `document-access`,
 *    the photo lookup and every future tool read that layout.
 */
import { z } from "zod";
import { supabase } from "@/lib/supabase";
import { QueryError } from "@/shared/api/query";
import { insertOne } from "@/shared/api/write";
import { nowInstantIso } from "@/lib/datetime";
import type { UploadableDocumentType } from "@/features/profile/api/documents.api";

export const DOCUMENTS_TABLE = "documents";
export const DOCUMENT_BUCKET = "documents";

export const attachedDocumentSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  status: z.string(),
});
export type AttachedDocument = z.infer<typeof attachedDocumentSchema>;

export interface AttachEmployeeDocumentInput {
  /** The person the document is ABOUT. */
  readonly employeeId: string;
  readonly companyId: string;
  /** `profiles.id` of the ADMIN doing the attaching. */
  readonly actorProfileId: string;
  readonly type: UploadableDocumentType;
  readonly title: string;
  readonly file: File;
  readonly issueDate: string | null;
  readonly expiryDate: string | null;
  /** Where it came from, in the admin's words — kept as data, not as a guess. */
  readonly note: string;
}

/** Same layout as the self path, so everything downstream reads one shape. */
function storagePathFor(employeeId: string, typeCode: string, fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") : "bin";
  return `employee/${employeeId}/${typeCode}/${crypto.randomUUID()}.${ext}`;
}

async function sha256Hex(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Best-effort cleanup. An admin DOES hold delete on this bucket, unlike an employee. */
async function removeQuietly(path: string): Promise<void> {
  try {
    await supabase.storage.from(DOCUMENT_BUCKET).remove([path]);
  } catch {
    // Swallowed on purpose: the caller is already rethrowing the real failure, and a
    // cleanup error would replace a useful message with a misleading one.
  }
}

/**
 * Upload the bytes, then register the row.
 *
 * ORDER AND FAILURE, matching the self path for the same reason: bytes first, because
 * `storage_path` is NOT NULL and a row pointing at an object that was never written is a
 * worse artefact than an object no row points at. If the metadata insert is refused the
 * object is removed and the ORIGINAL error is rethrown, so the caller reports what
 * actually went wrong rather than a cleanup detail.
 */
export async function attachEmployeeDocument(
  input: AttachEmployeeDocumentInput,
): Promise<AttachedDocument> {
  const checksum = await sha256Hex(input.file);
  const path = storagePathFor(input.employeeId, input.type.code, input.file.name);
  const mime = input.file.type === "" ? "application/octet-stream" : input.file.type;

  const uploaded = await supabase.storage.from(DOCUMENT_BUCKET).upload(path, input.file, {
    contentType: mime,
    upsert: false,
  });
  if (uploaded.error) {
    throw new QueryError(
      `storage/${DOCUMENT_BUCKET}`,
      "no_permission",
      uploaded.error.message,
      { cause: uploaded.error },
    );
  }

  try {
    return await insertOne(
      DOCUMENTS_TABLE,
      attachedDocumentSchema,
      {
        document_type_id: input.type.id,
        company_id: input.companyId,
        subject_kind: "employee",
        employee_id: input.employeeId,
        title: input.title.trim(),
        file_name: input.file.name,
        storage_bucket: DOCUMENT_BUCKET,
        storage_path: path,
        mime_type: mime,
        file_size_bytes: input.file.size,
        checksum_sha256: checksum,
        current_version: 1,
        // See the header, point 2: HR uploading IS the verification act.
        status: "approved",
        reviewed_by: input.actorProfileId,
        reviewed_at: nowInstantIso(),
        virus_scan_status: "pending",
        is_system_generated: false,
        is_confidential: false,
        requires_acknowledgement: false,
        uploaded_by: input.actorProfileId,
        issue_date: input.issueDate,
        expiry_date: input.expiryDate,
        tags: ["admin-upload"],
        source_reference: {
          uploaded_from: "/admin/people/new",
          note: input.note.trim(),
        },
      },
      { columns: "id, title, status" },
    );
  } catch (error) {
    await removeQuietly(path);
    throw error;
  }
}
