/**
 * documents.api.ts — E-07 Tab 6: the documents attached to the employee record.
 *
 * This is a SUBSET of E-09 scoped to the record, so it reads the same
 * `documents` table under the same `documents__self__select` RLS policy
 * (migration 025), which already excludes soft-deleted and virus-positive rows.
 *
 * DR-55 is the shape of this tab: the reference product listed
 * `SSSRC062_FORM 16_Part-B F Y 2025-2026.pdf` as the document NAME, put the file
 * extension in a "Type" column, showed `NA` as a status and attributed uploads
 * to `HR-HR001`. Here the name is `documents.title`, the type is
 * `document_types.name`, the status is the `document_status` enum, and there is
 * no extension column at all.
 */
import { z } from "zod";
import {
  QueryError,
  dbDateNullable,
  dbInt,
  dbTimestamp,
  dbUuid,
  eq,
  isFalse,
  isNull,
  isTrue,
  selectMany,
} from "@/shared/api/query";
import { insertOne } from "@/shared/api/write";
import { supabase } from "@/lib/supabase";

export const DOCUMENTS_TABLE = "documents";
export const DOCUMENT_TYPES_TABLE = "document_types";

export const documentStatusSchema = z.enum([
  "draft", "pending_review", "approved", "rejected", "expired", "superseded",
  "archived",
]);
export type DocumentStatus = z.infer<typeof documentStatusSchema>;

/**
 * The embedded `document_types` object is a PostgREST resource embedding, not a
 * client-side join: `document_type_id` is a declared FK (migration 025), so
 * `document_types(...)` resolves server-side in one round trip. It is nullable
 * in the schema because a RESTRICT'd FK can still be filtered out by the
 * document_types RLS policy, and a missing label must render as "Uncategorised"
 * rather than crash the grid.
 */
export const documentTypeRefSchema = z.object({
  code: z.string(),
  name: z.string(),
  category: z.string(),
  sub_category: z.string().nullable(),
});

export const profileDocumentSchema = z.object({
  id: dbUuid,
  title: z.string(),
  status: documentStatusSchema,
  issue_date: dbDateNullable,
  expiry_date: dbDateNullable,
  uploaded_at: dbTimestamp,
  is_system_generated: z.boolean(),
  requires_acknowledgement: z.boolean(),
  acknowledgement_due_on: dbDateNullable,
  is_confidential: z.boolean(),
  current_version: dbInt,
  page_count: z.union([z.number().int(), z.string().transform(Number), z.null()]),
  document_types: documentTypeRefSchema.nullable(),
});

export type ProfileDocument = z.infer<typeof profileDocumentSchema>;

const DOCUMENT_COLUMNS =
  "id, title, status, issue_date, expiry_date, uploaded_at, is_system_generated, " +
  "requires_acknowledgement, acknowledgement_due_on, is_confidential, " +
  "current_version, page_count, document_types(code, name, category, sub_category)";

/**
 * Documents on the employee's own record, newest first.
 *
 * `archived_at IS NULL` is applied here rather than left to RLS: the policy
 * permits archived rows (they remain the employee's documents), but a profile
 * tab should show the live vault. `deleted_at` and the virus filter are already
 * in the policy, so they are not duplicated.
 */
export async function fetchProfileDocuments(
  employeeId: string,
  signal?: AbortSignal,
): Promise<ProfileDocument[]> {
  return selectMany(DOCUMENTS_TABLE, profileDocumentSchema, {
    filters: [eq("employee_id", employeeId), isNull("archived_at")],
    order: [{ column: "uploaded_at", ascending: false }],
    columns: DOCUMENT_COLUMNS,
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

/** Human category label, or an honest fallback when the type row is withheld. */
export function categoryLabel(doc: ProfileDocument): string | null {
  return doc.document_types?.name ?? null;
}

/** True when the document's validity has an end date that has passed. */
export function isExpiredStatus(doc: ProfileDocument): boolean {
  return doc.status === "expired";
}

// =============================================================================
// 2. Employee upload — WHAT IS AND IS NOT DEPLOYED, verified not assumed
// =============================================================================
//
// THE BUCKET EXISTS. Migration 20260801003900_storage_buckets.sql creates twelve
// of them, `documents` among them (private, no mime allow-list, no size limit),
// and 20260801013000 re-pointed the 64 seeded rows at it after an earlier
// migration wrote two bucket names that never existed. So "no migration creates
// a storage bucket" is FALSE for this project, and this module uploads for real.
//
// THE WRITE PATH, exactly:
//
//  1. STORAGE. `documents__own_write` (039 §2) permits INSERT into
//     `storage.objects` when `bucket_id = 'documents'` AND
//     `(storage.foldername(name))[2] = app.current_employee_id()::text`.
//     `storage.foldername` returns the FOLDER segments, so element 2 is the
//     second folder — the path must be `<prefix>/<employee_id>/…`. That is why
//     `storagePathFor` puts the employee id in the second position and not the
//     first; `<employee_id>/<type>/<file>` would land the id at element 1 and be
//     refused. Same convention `uploadRegularizationEvidence` uses.
//
//  2. METADATA. `public.documents` had `documents__self__select`,
//     `documents__manager__select` and `documents__admin__all` and no self
//     INSERT, so bytes could be stored that no vault row pointed at. Migration
//     20260801014000 adds `documents__self__insert`, which pins the row to one
//     shape: subject_kind='employee', employee_id = me, company_id = my entity,
//     uploaded_by = my profile, status='pending_review',
//     virus_scan_status='pending', current_version=1, not system-generated, not
//     confidential, no acknowledgement, no reviewer, no e-sign, bucket
//     'documents', and a `document_types` row that is employee-visible and
//     neither e-signed nor acknowledgement-bearing. Every literal in
//     `uploadProfileDocument` below is there because the policy demands it.
//
// WHAT IS STILL MISSING, and is stated on screen rather than papered over:
//
//  * NO READ-BACK. 039 grants no self SELECT on the `documents` bucket by
//    design — reads are short-lived signed URLs minted by the `document-access`
//    edge function, which writes `document_access_log` FIRST and is not
//    deployed here. So the employee sees their upload's metadata and status, and
//    HR (whose `documents__admin_all` storage policy covers SELECT) opens the
//    file. Offering a download button that 400s would be the dishonest option.
//  * NO VERSION ROW. `document_versions__admin__insert` is admin-only, so an
//    employee upload has `current_version = 1` and no `document_versions` row.
//    Correct rather than convenient: the alternative is granting employees
//    write access to the version chain.
//  * NO VIRUS VERDICT. `virus_scan_status` stays 'pending' until the scanner
//    runs. `documents_virus_gate` only blocks a servable status on an
//    'infected' row, so 'pending' inserts fine — and the screen says the file
//    is unchecked.
//
// `documents` IS in `audit.reason_required_tables`, but with the default
// `applies_to = 'update_delete'` — so an INSERT needs no `X-Reason` and
// `insertOne` is the right helper. The employee's own sentence is therefore
// carried as data (`source_reference.note`) rather than as a header, which is
// also where it survives for HR to read in the queue.

/** The only bucket an employee-supplied document may live in. */
export const PROFILE_DOCUMENT_BUCKET = "documents";

/** Minimum length of the employee's "why" note. Matches MIN_REASON_LENGTH. */
export const UPLOAD_NOTE_MIN_LENGTH = 10;

/**
 * A `document_types` row an employee may file against.
 *
 * `allowed_mime_types` and `max_file_size_mb` are NOT NULL in the table with
 * defaults ('{application/pdf,image/jpeg,image/png}', 10), so both are required
 * here — a null would mean the projection is wrong, not that anything goes.
 */
export const uploadableDocumentTypeSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  category: z.string(),
  sub_category: z.string().nullable(),
  requires_expiry: z.boolean(),
  requires_approval: z.boolean(),
  is_sensitive: z.boolean(),
  is_required_for_onboarding: z.boolean(),
  allowed_mime_types: z.array(z.string()),
  max_file_size_mb: dbInt,
  storage_bucket: z.string(),
  sort_order: dbInt,
});

export type UploadableDocumentType = z.infer<typeof uploadableDocumentTypeSchema>;

const UPLOADABLE_TYPE_COLUMNS =
  "id, code, name, description, category, sub_category, requires_expiry, " +
  "requires_approval, is_sensitive, is_required_for_onboarding, " +
  "allowed_mime_types, max_file_size_mb, storage_bucket, sort_order";

/**
 * The types the employee may supply, filtered to exactly what
 * `documents__self__insert` will accept.
 *
 * The predicates are the policy's, restated so the picker cannot offer a type the
 * database would refuse: `visible_to_employee` (a type whose own copy the employee
 * may not even read is not theirs to file), `employee_uploadable` (HR files this
 * one), `NOT requires_esign` (an offer letter or contract is ISSUED and signed,
 * never uploaded) and `NOT requires_acknowledgement` (a policy or SOP is published
 * TO an employee). `is_active AND deleted_at IS NULL` is also what
 * `document_types__authenticated__select` permits, so it is applied here rather
 * than relied on.
 *
 * REPORTED: a joiner filled in the Aadhaar upload form — issue date, reason, the
 * lot — chose a file, and only then was told "the database refused to record this
 * document". Aadhaar, PAN and bank proof had become HR-upload-only
 * (`employee_uploadable = false`), the insert policy gained a matching clause, and
 * this list did not. The offer and the refusal disagreed, and the person found out
 * last. Every predicate in that policy has to appear here, or the screen is lying
 * about what it will accept.
 */
export async function fetchUploadableDocumentTypes(
  signal?: AbortSignal,
): Promise<UploadableDocumentType[]> {
  return selectMany(DOCUMENT_TYPES_TABLE, uploadableDocumentTypeSchema, {
    filters: [
      isTrue("is_active"),
      isNull("deleted_at"),
      isTrue("visible_to_employee"),
      isTrue("employee_uploadable"),
      isFalse("requires_esign"),
      isFalse("requires_acknowledgement"),
    ],
    order: [{ column: "sort_order" }, { column: "name" }],
    columns: UPLOADABLE_TYPE_COLUMNS,
    limit: 100,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Onboarding-required types with nothing on the record yet.
 *
 * Compared by `document_types.code` against the embedded type on each document,
 * because that is the only stable identifier both sides carry — `title` is free
 * text and the profile projection does not select `document_type_id`. A document
 * whose type row was withheld by RLS is skipped rather than counted as a match:
 * claiming a requirement is met on evidence that was hidden is the exact class
 * of lie this build removes.
 */
export function missingOnboardingTypes(
  types: readonly UploadableDocumentType[],
  documents: readonly ProfileDocument[],
): UploadableDocumentType[] {
  const held = new Set<string>();
  for (const doc of documents) {
    const code = doc.document_types?.code;
    if (code !== undefined && doc.status !== "rejected") held.add(code);
  }
  return types.filter((type) => type.is_required_for_onboarding && !held.has(type.code));
}

/**
 * `ck_documents__checksum` is `^[0-9a-f]{64}$` — a real SHA-256 of the real
 * bytes, which is what makes "the file served equals the file signed" checkable
 * later. Computed with WebCrypto, which needs a secure context; a browser
 * without `crypto.subtle` gets an honest refusal instead of a fabricated digest.
 */
export async function sha256Hex(file: File): Promise<string> {
  if (typeof crypto === "undefined" || crypto.subtle === undefined) {
    throw new QueryError(
      `storage/${PROFILE_DOCUMENT_BUCKET}`,
      "unknown",
      "This browser cannot compute a SHA-256 digest, so the file cannot be fingerprinted.",
    );
  }
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Lower-case extension of a file name, or 'bin' when it has none. */
function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return "bin";
  const ext = fileName.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : "bin";
}

/**
 * `<prefix>/<employee_id>/<type_code>/<uuid>.<ext>`.
 *
 * The employee id MUST be the second folder segment: `documents__own_write`
 * checks `(storage.foldername(name))[2]`. The type code third groups an
 * employee's files the way HR reads them, and the uuid means a re-upload of the
 * same file name never collides (`upsert: false` below would refuse it).
 */
export function storagePathFor(employeeId: string, typeCode: string, fileName: string): string {
  const uuid = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${employeeId}-${String(fileName.length)}`;
  return `employee/${employeeId}/${typeCode}/${uuid}.${extensionOf(fileName)}`;
}

/**
 * What the INSERT reads back.
 *
 * Deliberately NOT `profileDocumentSchema`: that one requires the embedded
 * `document_types(...)` resource, and a POST whose `select=` embed did not
 * resolve would fail zod parsing AFTER the row was written — reporting a
 * failure for a document that is on the record is the worst of both. Three
 * plain columns of the row PostgREST just wrote cannot do that; the list
 * refetch that follows the invalidation supplies the rest.
 */
export const insertedDocumentSchema = z.object({
  id: dbUuid,
  title: z.string(),
  status: documentStatusSchema,
});

export type InsertedDocument = z.infer<typeof insertedDocumentSchema>;

export interface UploadProfileDocumentInput {
  readonly employeeId: string;
  readonly companyId: string;
  /** `profiles.id` — `documents.uploaded_by` references profiles, NOT auth.users. */
  readonly profileId: string;
  readonly type: UploadableDocumentType;
  readonly title: string;
  readonly file: File;
  /** Civil dates 'YYYY-MM-DD'; expiry is mandatory when the type expires. */
  readonly issueDate: string | null;
  readonly expiryDate: string | null;
  /** The employee's own sentence, kept as data so HR reads it in the queue. */
  readonly note: string;
}

/**
 * Upload the bytes, then register the row. Returns the registered document.
 *
 * ORDER MATTERS AND SO DOES THE FAILURE PATH. The bytes go first because
 * `documents.storage_path` is NOT NULL and a row pointing at an object that was
 * never written is a worse artefact than an object no row points at. If the
 * metadata insert is then refused, this function tries to remove the object and
 * — because 039 grants an employee INSERT but no DELETE on the bucket, so the
 * removal will itself usually be refused — rethrows the ORIGINAL error either
 * way. The caller must report that nothing was added to the record, which is
 * true: without the row, the vault has no document.
 */
export async function uploadProfileDocument(
  input: UploadProfileDocumentInput,
): Promise<InsertedDocument> {
  const checksum = await sha256Hex(input.file);
  const path = storagePathFor(input.employeeId, input.type.code, input.file.name);

  const uploaded = await supabase.storage
    .from(PROFILE_DOCUMENT_BUCKET)
    .upload(path, input.file, {
      contentType: input.file.type === "" ? "application/octet-stream" : input.file.type,
      upsert: false,
    });
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
        title: input.title.trim(),
        file_name: input.file.name,
        storage_bucket: PROFILE_DOCUMENT_BUCKET,
        storage_path: path,
        mime_type: input.file.type === "" ? "application/octet-stream" : input.file.type,
        file_size_bytes: input.file.size,
        checksum_sha256: checksum,
        current_version: 1,
        // Every literal below is required by documents__self__insert.
        //
        // The STATUS is the one thing that is no longer a literal. The type says
        // whether a human has anything to check: an Aadhaar or a bank proof asserts
        // something the company would otherwise take on trust, so it waits for HR; a
        // photograph asserts nothing, so it is approved on arrival. Putting a photo in
        // the review queue was not merely useless — it trains people to clear the
        // queue without looking, which is how a real Aadhaar mismatch gets waved
        // through. Migration 086 sets the flag and the RLS policy enforces exactly
        // this expression, so a mismatch here is rejected rather than silently
        // accepted.
        status: input.type.requires_approval ? "pending_review" : "approved",
        virus_scan_status: "pending",
        is_system_generated: false,
        is_confidential: false,
        requires_acknowledgement: false,
        uploaded_by: input.profileId,
        issue_date: input.issueDate,
        expiry_date: input.expiryDate,
        tags: ["employee-upload"],
        source_reference: {
          uploaded_from: "/me/profile/documents",
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

/**
 * Best-effort cleanup of an object whose metadata row was refused. Expected to
 * fail: 039 grants an employee INSERT into the `documents` bucket and no DELETE.
 * A failure to tidy up must never replace the real reason the insert was
 * refused, so nothing here is rethrown or reported.
 */
async function removeQuietly(path: string): Promise<void> {
  try {
    await supabase.storage.from(PROFILE_DOCUMENT_BUCKET).remove([path]);
  } catch {
    // Deliberately swallowed — see above.
  }
}
