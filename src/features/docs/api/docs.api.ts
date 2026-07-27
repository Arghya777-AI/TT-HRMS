/**
 * docs.api.ts — every E-09 read, and nothing else.
 *
 * Schemas mirror the DEPLOYED tables in migration 025 (`documents`,
 * `document_types`, `document_acknowledgements`) column for column. Where
 * spec-employee §5 E-09 names a field the deployed schema does not have, the
 * field is ABSENT rather than faked:
 *
 *  - There is no `documents.source` column. The spec's
 *    `company_issued | employee_upload | system_generated` split is derived from
 *    what the table DOES carry: `is_system_generated`, and whether
 *    `uploaded_by` is the caller's own profile. That is a partition of one read,
 *    not a computation — the two tabs cannot disagree because they are two
 *    filters over the same rows.
 *  - There is no `is_visible_to_employee` column on `documents`; visibility is
 *    `document_types.visible_to_employee`, enforced inside the RLS policy
 *    `documents__self__select`. The client therefore never filters on it.
 *  - Opening a file needs the `document-access` edge function (it writes
 *    `document_access_log` BEFORE minting a signed URL). That function is not
 *    deployed, so this module exposes no download path at all rather than
 *    minting an unlogged URL from the browser.
 *  - Self-upload needs an INSERT policy on `documents` for the employee. None
 *    exists (migration 025 grants INSERT but writes no self policy), so no
 *    upload call is offered.
 */
import { z } from "zod";
import {
  dbDateNullable,
  dbInt,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  inList,
  selectMany,
} from "@/shared/api/query";

export const DOCUMENTS_TABLE = "documents";
export const DOCUMENT_TYPES_TABLE = "document_types";
export const DOCUMENT_ACKS_TABLE = "document_acknowledgements";

/** `public.document_status` (migration 003). */
export const documentStatusSchema = z.enum([
  "draft",
  "pending_review",
  "approved",
  "rejected",
  "expired",
  "superseded",
  "archived",
]);
export type DocumentStatus = z.infer<typeof documentStatusSchema>;

/** `document_types.category` CHECK (migration 025). */
export const documentCategorySchema = z.enum([
  "identity",
  "employment",
  "education",
  "statutory",
  "payroll",
  "policy",
  "compliance",
  "medical",
  "exit",
  "other",
]);
export type DocumentCategory = z.infer<typeof documentCategorySchema>;

/** The embedded `document_types` projection — the human category label. */
export const documentTypeRefSchema = z.object({
  code: z.string(),
  name: z.string(),
  category: documentCategorySchema,
  requires_expiry: z.boolean(),
});

export const documentSchema = z.object({
  id: dbUuid,
  document_type_id: dbUuid,
  employee_id: dbUuidNullable,
  /** Display title. NEVER the filename (DR-55). */
  title: z.string(),
  file_name: z.string(),
  mime_type: z.string(),
  file_size_bytes: dbInt,
  page_count: z.number().int().nullable(),
  current_version: dbInt,
  status: documentStatusSchema,
  issue_date: dbDateNullable,
  /** NULL = open-ended → "No expiry", never a year-3000 sentinel (DR-19). */
  expiry_date: dbDateNullable,
  uploaded_by: dbUuid,
  uploaded_at: dbTimestamp,
  reviewed_at: dbTimestampNullable,
  review_comment: z.string().nullable(),
  is_system_generated: z.boolean(),
  requires_acknowledgement: z.boolean(),
  acknowledgement_due_on: dbDateNullable,
  document_types: documentTypeRefSchema.nullable(),
});

export type DocumentRow = z.infer<typeof documentSchema>;

const DOCUMENT_COLUMNS =
  "id, document_type_id, employee_id, title, file_name, mime_type, file_size_bytes, " +
  "page_count, current_version, status, issue_date, expiry_date, uploaded_by, uploaded_at, " +
  "reviewed_at, review_comment, is_system_generated, requires_acknowledgement, " +
  "acknowledgement_due_on, document_types(code, name, category, requires_expiry)";

/**
 * Every document on the caller's own employee record that they are allowed to
 * see. RLS (`documents__self__select`) already restricts this to
 * `employee_id = app.current_employee_id()` AND a type flagged
 * `visible_to_employee` AND a clean virus scan; the filter below is for the
 * index, not for safety.
 */
export async function fetchMyDocuments(
  employeeId: string,
  signal?: AbortSignal,
): Promise<DocumentRow[]> {
  return selectMany(DOCUMENTS_TABLE, documentSchema, {
    columns: DOCUMENT_COLUMNS,
    filters: [eq("employee_id", employeeId)],
    order: [
      { column: "issue_date", ascending: false, nullsFirst: false },
      { column: "uploaded_at", ascending: false },
    ],
    limit: 300,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// Acknowledgements — tab 3 ("Signed & acknowledged")
// -----------------------------------------------------------------------------

/** `document_acknowledgements.status` CHECK (migration 025). */
export const ackStatusSchema = z.enum([
  "assigned",
  "opened",
  "acknowledged",
  "overdue",
  "waived",
]);
export type AckStatus = z.infer<typeof ackStatusSchema>;

/**
 * One acknowledgement assignment.
 *
 * `documents` is embedded but NULLABLE on purpose: a company-wide policy row
 * (`subject_kind = 'policy'`, `employee_id IS NULL`) is withheld from the
 * employee by `documents__self__select`, so the join comes back empty. The UI
 * says so instead of inventing a title.
 */
export const documentAckSchema = z.object({
  id: dbUuid,
  document_id: dbUuid,
  employee_id: dbUuid,
  assigned_at: dbTimestamp,
  due_on: dbDateNullable,
  first_opened_at: dbTimestampNullable,
  open_count: dbInt,
  total_read_seconds: dbInt,
  scroll_completion_pct: z.union([z.number(), z.string().transform(Number)]),
  acknowledged_at: dbTimestampNullable,
  acknowledgement_text: z.string().nullable(),
  status: ackStatusSchema,
  documents: z
    .object({
      id: dbUuid,
      title: z.string(),
      current_version: dbInt,
      page_count: z.number().int().nullable(),
      issue_date: dbDateNullable,
      document_types: documentTypeRefSchema.nullable(),
    })
    .nullable(),
});

export type DocumentAck = z.infer<typeof documentAckSchema>;

export const DOCUMENT_ACK_COLUMNS =
  "id, document_id, employee_id, assigned_at, due_on, first_opened_at, open_count, " +
  "total_read_seconds, scroll_completion_pct, acknowledged_at, acknowledgement_text, status, " +
  "documents(id, title, current_version, page_count, issue_date, " +
  "document_types(code, name, category, requires_expiry))";

/** Every acknowledgement assigned to the caller, newest assignment first. */
export async function fetchMyAcknowledgements(
  employeeId: string,
  signal?: AbortSignal,
): Promise<DocumentAck[]> {
  return selectMany(DOCUMENT_ACKS_TABLE, documentAckSchema, {
    columns: DOCUMENT_ACK_COLUMNS,
    filters: [eq("employee_id", employeeId)],
    order: [{ column: "assigned_at", ascending: false }],
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

/** Only the ones actually signed off — tab 3 of E-09. */
export async function fetchMySignedAcknowledgements(
  employeeId: string,
  signal?: AbortSignal,
): Promise<DocumentAck[]> {
  return selectMany(DOCUMENT_ACKS_TABLE, documentAckSchema, {
    columns: DOCUMENT_ACK_COLUMNS,
    filters: [eq("employee_id", employeeId), inList("status", ["acknowledged", "waived"])],
    order: [{ column: "acknowledged_at", ascending: false }],
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// Tab partition — one read, two lists, no possibility of disagreement
// -----------------------------------------------------------------------------

export interface MyDocumentTabs {
  /** Published to the employee by HR or generated by the system. */
  readonly issued: DocumentRow[];
  /** Uploaded by the employee themselves. */
  readonly uploads: DocumentRow[];
}

/**
 * Split the caller's documents into the two E-09 tabs.
 *
 * `profileId` is the caller's `profiles.id` (= `auth.uid()`), which is what
 * `documents.uploaded_by` references. When it is unknown we cannot tell an HR
 * upload from a self upload, so everything is treated as issued — a wrong tab is
 * recoverable; a fabricated attribution is not.
 */
export function partitionMyDocuments(
  rows: readonly DocumentRow[],
  profileId: string | null,
): MyDocumentTabs {
  const issued: DocumentRow[] = [];
  const uploads: DocumentRow[] = [];
  for (const row of rows) {
    const isSelfUpload =
      profileId !== null && !row.is_system_generated && row.uploaded_by === profileId;
    (isSelfUpload ? uploads : issued).push(row);
  }
  return { issued, uploads };
}

/** Who filed a document, in words — never `HR-HR001` (DR-53). */
export type DocumentFiler = "system" | "you" | "hr";

export function filerOf(row: DocumentRow, profileId: string | null): DocumentFiler {
  if (row.is_system_generated) return "system";
  if (profileId !== null && row.uploaded_by === profileId) return "you";
  return "hr";
}
