/**
 * documents.api.ts — every read and write behind the eight `/admin/documents/**`
 * screens, and nothing else.
 *
 * Schemas mirror the DEPLOYED objects column for column:
 *   - `public.documents`, `public.document_types`,
 *     `public.document_acknowledgements`, `public.document_access_log`
 *     (migration 025)
 *   - `public.contract_templates`, `public.e_sign_requests`,
 *     `public.e_sign_signers` (migration 026)
 *   - `public.v_document_compliance`, `public.v_policy_acknowledgement_status`
 *     (migration 037)
 *   - the `document-generate` edge function's request/response contract
 *     (`supabase/functions/document-generate/index.ts`)
 *
 * What this module deliberately does NOT offer, because the server does not:
 *
 *  1. NO FILE OPENING. `documents` says it in its own COMMENT: a file is served
 *     only through a signed URL minted by the `document-access` edge function,
 *     which writes `document_access_log` FIRST. There is no
 *     `supabase/functions/document-access/` in this repo, so no download path is
 *     exposed at all rather than minting an unlogged URL from the browser.
 *  2. NO REVIEW DECISION. Approving or rejecting an upload has no server-side
 *     path: there is no `decide_document_review` RPC anywhere in
 *     `supabase/migrations/`, and `documents.reviewed_at` / `reviewed_by` have no
 *     trigger to fill them. A PATCH of `status` alone would record half a
 *     review, so the Approval Queue is a register and says so.
 *  3. NO ACKNOWLEDGEMENT WAIVER. `ck_da__waive_reason` needs `waived_by` +
 *     `waived_at` + a reason, and `document_acknowledgements_ack_guard`
 *     deliberately owns the informed-consent gate. Same reasoning as (2).
 *  4. NO CATEGORY FILTER ON THE REPOSITORY. `documents` carries no category —
 *     it lives on `document_types`. Filtering an embedded resource needs raw
 *     PostgREST syntax the query layer bans, so a category choice narrows the
 *     TYPE PICKER and the wire filter is `document_type_id IN (…)`. Same rows,
 *     one predicate, and the count cannot disagree with the grid.
 *
 * `document_types` is a lookup and is NOT in `audit.reason_required_tables`;
 * `public.documents` IS (for update/delete). Every write here goes through the
 * audited helpers anyway, so the reason reaches `audit_log` either way.
 */
import { z } from "zod";
import {
  SENSITIVE_REASON_LENGTH,
  dbDateNullable,
  dbInt,
  dbIntNullable,
  dbNumericNullable,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  gte,
  ilike,
  inList,
  insertRow,
  isNotNull,
  isNull,
  isTrue,
  lt,
  lte,
  paginate,
  selectCount,
  selectMany,
  softDelete,
  updateRow,
  type Cursor,
  type Filter,
  type Page,
} from "@/shared/api/query";
import { invokeEdgeFn, newIdempotencyKey } from "@/shared/api/invoke";

export const DOCUMENTS_TABLE = "documents";
export const DOCUMENT_TYPES_TABLE = "document_types";
export const DOCUMENT_ACKS_TABLE = "document_acknowledgements";
export const DOCUMENT_ACCESS_LOG_TABLE = "document_access_log";
export const CONTRACT_TEMPLATES_TABLE = "contract_templates";
export const ESIGN_REQUESTS_TABLE = "e_sign_requests";
export const ESIGN_SIGNERS_TABLE = "e_sign_signers";
export const V_DOCUMENT_COMPLIANCE = "v_document_compliance";
export const V_POLICY_ACK_STATUS = "v_policy_acknowledgement_status";

/** The default audit sentence for a routine document-type field edit. */
export const REASON_DOC_TYPE_MASTER = "admin console: edited the document type master";

// -----------------------------------------------------------------------------
// Shared vocabularies — the DEPLOYED enums and CHECKs, verbatim
// -----------------------------------------------------------------------------

/** `public.document_status` (migration 003). */
export const documentStatusValues = [
  "draft",
  "pending_review",
  "approved",
  "rejected",
  "expired",
  "superseded",
  "archived",
] as const;
export const documentStatusSchema = z.enum(documentStatusValues);
export type DocumentStatus = z.infer<typeof documentStatusSchema>;

/** `ck_document_types__category`. */
export const documentCategoryValues = [
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
] as const;
export const documentCategorySchema = z.enum(documentCategoryValues);
export type DocumentCategory = z.infer<typeof documentCategorySchema>;

/** `ck_documents__subject_kind`. */
export const subjectKindValues = [
  "employee",
  "company",
  "policy",
  "asset",
  "payroll_run",
  "event",
  "vendor",
] as const;
export type SubjectKind = (typeof subjectKindValues)[number];

/** `ck_documents__virus_scan_status`. */
export const virusScanValues = ["pending", "clean", "infected", "skipped"] as const;
export const virusScanSchema = z.enum(virusScanValues);
export type VirusScanStatus = z.infer<typeof virusScanSchema>;

/** `ck_document_types__retention_basis`. */
export const retentionBasisValues = [
  "from_upload",
  "from_exit",
  "from_expiry",
  "indefinite",
] as const;

/** `ck_da__status` — acknowledgement lifecycle. */
export const ackStatusValues = [
  "assigned",
  "opened",
  "acknowledged",
  "overdue",
  "waived",
] as const;
export const ackStatusSchema = z.enum(ackStatusValues);
export type AckStatus = z.infer<typeof ackStatusSchema>;

/** `v_document_compliance.compliance_status` — the four CASE branches. */
export const complianceStatusValues = [
  "missing",
  "expired",
  "expiring_soon",
  "valid",
] as const;
export const complianceStatusSchema = z.enum(complianceStatusValues);
export type ComplianceStatus = z.infer<typeof complianceStatusSchema>;

/** `ck_dal__access_kind`. */
export const accessKindValues = [
  "view",
  "download",
  "print",
  "signed_url_minted",
  "email_attachment",
  "api",
] as const;
export const accessKindSchema = z.enum(accessKindValues);
export type AccessKind = z.infer<typeof accessKindSchema>;

/** `public.esign_status` (migration 003). */
export const esignStatusValues = [
  "draft",
  "sent",
  "partially_signed",
  "completed",
  "declined",
  "expired",
  "cancelled",
  "voided",
] as const;
export const esignStatusSchema = z.enum(esignStatusValues);
export type EsignStatus = z.infer<typeof esignStatusSchema>;

/** `public.signer_status`. */
export const signerStatusValues = [
  "pending",
  "notified",
  "viewed",
  "identity_verified",
  "signed",
  "declined",
  "delegated",
  "expired",
] as const;
export const signerStatusSchema = z.enum(signerStatusValues);
export type SignerStatus = z.infer<typeof signerStatusSchema>;

/** `ck_contract_templates__contract_kind`. */
export const contractKindValues = [
  "employment_permanent",
  "employment_probation",
  "fixed_term",
  "internship",
  "consultant",
  "retainer",
  "casual_daily_wage",
  "nda",
  "non_compete",
  "training_bond",
] as const;
export const contractKindSchema = z.enum(contractKindValues);
export type ContractKind = z.infer<typeof contractKindSchema>;

/** The private buckets migration 039 actually creates. */
export const documentBucketValues = [
  "documents",
  "contracts",
  "payslips",
  "signatures",
  "archive",
] as const;

/** `document_types.allowed_mime_types` default set. */
export const allowedMimeValues = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

// -----------------------------------------------------------------------------
// 1. document_types — the master behind /admin/documents/types
// -----------------------------------------------------------------------------

export const documentTypeSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sort_order: dbInt,
  is_active: z.boolean(),
  category: documentCategorySchema,
  sub_category: z.string().nullable(),
  is_required_for_onboarding: z.boolean(),
  required_for_employment_types: z.array(z.string()).nullable(),
  required_for_department_ids: z.array(dbUuid).nullable(),
  requires_expiry: z.boolean(),
  expiry_reminder_days: z.array(dbInt),
  requires_approval: z.boolean(),
  requires_acknowledgement: z.boolean(),
  acknowledgement_deadline_days: dbIntNullable,
  requires_esign: z.boolean(),
  retention_years: dbInt,
  retention_basis: z.string(),
  allowed_mime_types: z.array(z.string()),
  max_file_size_mb: dbInt,
  storage_bucket: z.string(),
  is_sensitive: z.boolean(),
  visible_to_employee: z.boolean(),
  visible_to_manager: z.boolean(),
  template_id: dbUuidNullable,
  deleted_at: dbTimestampNullable,
  created_at: dbTimestamp,
  updated_at: dbTimestamp,
});
export type DocumentType = z.infer<typeof documentTypeSchema>;

export interface DocumentTypeFilters {
  readonly categories?: readonly DocumentCategory[];
  readonly includeInactive?: boolean;
  /** True → ONLY soft-deleted rows (the archive view). */
  readonly archived?: boolean;
  readonly nameLike?: string;
  readonly requiresExpiryOnly?: boolean;
  readonly requiresAckOnly?: boolean;
  readonly requiresEsignOnly?: boolean;
  readonly onboardingOnly?: boolean;
}

function documentTypeFilters(f: DocumentTypeFilters): Filter[] {
  const filters: Filter[] = [
    f.archived === true ? isNotNull("deleted_at") : isNull("deleted_at"),
  ];
  if (f.includeInactive !== true && f.archived !== true) filters.push(isTrue("is_active"));
  if (f.categories !== undefined && f.categories.length > 0)
    filters.push(inList("category", f.categories));
  if (f.nameLike !== undefined && f.nameLike.trim() !== "")
    filters.push(ilike("name", `%${f.nameLike.trim()}%`));
  if (f.requiresExpiryOnly === true) filters.push(isTrue("requires_expiry"));
  if (f.requiresAckOnly === true) filters.push(isTrue("requires_acknowledgement"));
  if (f.requiresEsignOnly === true) filters.push(isTrue("requires_esign"));
  if (f.onboardingOnly === true) filters.push(isTrue("is_required_for_onboarding"));
  return filters;
}

/** The whole master (26 seeded rows), ordered as the admin maintains it. */
export function fetchDocumentTypes(
  f: DocumentTypeFilters = {},
  signal?: AbortSignal,
): Promise<DocumentType[]> {
  return selectMany(DOCUMENT_TYPES_TABLE, documentTypeSchema, {
    filters: documentTypeFilters(f),
    order: [
      { column: "category", ascending: true },
      { column: "sort_order", ascending: true },
    ],
    limit: 500,
    ...(signal ? { signal } : {}),
  });
}

export function countDocumentTypes(
  f: DocumentTypeFilters = {},
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(DOCUMENT_TYPES_TABLE, documentTypeFilters(f), {
    ...(signal ? { signal } : {}),
  });
}

/** Active types reduced to what a picker renders — name and category, never code. */
export interface DocumentTypeOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly category: DocumentCategory;
  readonly requiresExpiry: boolean;
  readonly requiresEsign: boolean;
  readonly requiresAck: boolean;
  readonly ackDeadlineDays: number | null;
}

export async function fetchDocumentTypeOptions(
  signal?: AbortSignal,
): Promise<DocumentTypeOption[]> {
  const rows = await fetchDocumentTypes({}, signal);
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    requiresExpiry: row.requires_expiry,
    requiresEsign: row.requires_esign,
    requiresAck: row.requires_acknowledgement,
    ackDeadlineDays: row.acknowledgement_deadline_days,
  }));
}

/** Create a document type. `document_types__admin__insert` gates this. */
export function insertDocumentType(
  values: Readonly<Record<string, unknown>>,
  reason: string,
  signal?: AbortSignal,
): Promise<DocumentType> {
  return insertRow(DOCUMENT_TYPES_TABLE, values, documentTypeSchema, {
    reason,
    ...(signal ? { signal } : {}),
  });
}

export function updateDocumentType(
  id: string,
  patch: Readonly<Record<string, unknown>>,
  reason: string,
  signal?: AbortSignal,
): Promise<DocumentType> {
  return updateRow(DOCUMENT_TYPES_TABLE, [eq("id", id)], patch, documentTypeSchema, {
    reason,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Retire a document type (D-23 soft delete). Never a DELETE: `documents` holds
 * `ON DELETE RESTRICT` against this table and `DELETE` is revoked from
 * `authenticated` anyway.
 */
export function archiveDocumentType(
  id: string,
  reason: string,
  signal?: AbortSignal,
): Promise<void> {
  return softDelete(DOCUMENT_TYPES_TABLE, id, {
    reason,
    minReasonLength: SENSITIVE_REASON_LENGTH,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 2. documents — the repository register
// -----------------------------------------------------------------------------

/** The `document_types` projection embedded on every document row. */
export const documentTypeRefSchema = z.object({
  code: z.string(),
  name: z.string(),
  category: documentCategorySchema,
  requires_expiry: z.boolean(),
  is_sensitive: z.boolean(),
});

export const adminDocumentSchema = z.object({
  id: dbUuid,
  document_type_id: dbUuid,
  company_id: dbUuid,
  subject_kind: z.string(),
  employee_id: dbUuidNullable,
  title: z.string(),
  file_name: z.string(),
  storage_bucket: z.string(),
  mime_type: z.string(),
  file_size_bytes: dbInt,
  page_count: dbIntNullable,
  current_version: dbInt,
  status: documentStatusSchema,
  issue_date: dbDateNullable,
  /** NULL = open-ended. Never a year-3000 sentinel (`ck_documents__no_sentinel_dates`). */
  expiry_date: dbDateNullable,
  uploaded_by: dbUuid,
  uploaded_at: dbTimestamp,
  reviewed_by: dbUuidNullable,
  reviewed_at: dbTimestampNullable,
  review_comment: z.string().nullable(),
  is_system_generated: z.boolean(),
  generated_from_template_id: dbUuidNullable,
  requires_acknowledgement: z.boolean(),
  acknowledgement_due_on: dbDateNullable,
  esign_request_id: dbUuidNullable,
  tags: z.array(z.string()),
  is_confidential: z.boolean(),
  virus_scan_status: virusScanSchema,
  retention_until: dbDateNullable,
  archived_at: dbTimestampNullable,
  deleted_at: dbTimestampNullable,
  document_types: documentTypeRefSchema.nullable(),
});
export type AdminDocument = z.infer<typeof adminDocumentSchema>;

const DOCUMENT_COLUMNS =
  "id, document_type_id, company_id, subject_kind, employee_id, title, file_name, " +
  "storage_bucket, mime_type, file_size_bytes, page_count, current_version, status, " +
  "issue_date, expiry_date, uploaded_by, uploaded_at, reviewed_by, reviewed_at, " +
  "review_comment, is_system_generated, generated_from_template_id, " +
  "requires_acknowledgement, acknowledgement_due_on, esign_request_id, tags, " +
  "is_confidential, virus_scan_status, retention_until, archived_at, deleted_at, " +
  "document_types(code, name, category, requires_expiry, is_sensitive)";

export interface DocumentFilters {
  readonly typeIds?: readonly string[];
  readonly statuses?: readonly DocumentStatus[];
  readonly employeeId?: string;
  readonly subjectKind?: SubjectKind;
  readonly titleLike?: string;
  readonly virusScanStatuses?: readonly VirusScanStatus[];
  readonly confidentialOnly?: boolean;
  readonly requiresAckOnly?: boolean;
  readonly systemGeneratedOnly?: boolean;
  /** Only rows that carry an expiry date at all. */
  readonly hasExpiryOnly?: boolean;
  /** `expiry_date <= this` — the "lapsing by" window. */
  readonly expiringOnOrBefore?: string;
  /** `expiry_date >= this` — pairs with the above for a closed window. */
  readonly expiringOnOrAfter?: string;
  /** True → ONLY soft-deleted rows. */
  readonly archived?: boolean;
}

/**
 * ONE predicate builder, shared by the paged read and the header count, so the
 * total can never disagree with the rows (DR-29).
 */
function documentFilters(f: DocumentFilters): Filter[] {
  const filters: Filter[] = [
    f.archived === true ? isNotNull("deleted_at") : isNull("deleted_at"),
  ];
  if (f.typeIds !== undefined && f.typeIds.length > 0)
    filters.push(inList("document_type_id", f.typeIds));
  if (f.statuses !== undefined && f.statuses.length > 0)
    filters.push(inList("status", f.statuses));
  if (f.employeeId !== undefined && f.employeeId !== "")
    filters.push(eq("employee_id", f.employeeId));
  if (f.subjectKind !== undefined) filters.push(eq("subject_kind", f.subjectKind));
  if (f.titleLike !== undefined && f.titleLike.trim() !== "")
    filters.push(ilike("title", `%${f.titleLike.trim()}%`));
  if (f.virusScanStatuses !== undefined && f.virusScanStatuses.length > 0)
    filters.push(inList("virus_scan_status", f.virusScanStatuses));
  if (f.confidentialOnly === true) filters.push(isTrue("is_confidential"));
  if (f.requiresAckOnly === true) filters.push(isTrue("requires_acknowledgement"));
  if (f.systemGeneratedOnly === true) filters.push(isTrue("is_system_generated"));
  if (f.hasExpiryOnly === true) filters.push(isNotNull("expiry_date"));
  if (f.expiringOnOrBefore !== undefined && f.expiringOnOrBefore !== "")
    filters.push(lte("expiry_date", f.expiringOnOrBefore));
  if (f.expiringOnOrAfter !== undefined && f.expiringOnOrAfter !== "")
    filters.push(gte("expiry_date", f.expiringOnOrAfter));
  return filters;
}

/**
 * One keyset page of the repository, newest filing first. `documents` is written
 * while it is read (a generation, an upload), so OFFSET paging would repeat and
 * skip rows; the cursor rides `(uploaded_at, id)`.
 */
export function fetchDocuments(
  f: DocumentFilters,
  pageSize: number,
  cursor: Cursor | null,
  signal?: AbortSignal,
): Promise<Page<AdminDocument>> {
  return paginate(DOCUMENTS_TABLE, adminDocumentSchema, {
    orderBy: "uploaded_at",
    ascending: false,
    tiebreak: "id",
    pageSize,
    cursor,
    filters: documentFilters(f),
    columns: DOCUMENT_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

export function countDocuments(f: DocumentFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(DOCUMENTS_TABLE, documentFilters(f), { ...(signal ? { signal } : {}) });
}

/**
 * An unpaged slice for the small queues (pending review, expiring soon), where
 * the whole list is the point and a cap plus a server count is honest.
 */
export function fetchDocumentList(
  f: DocumentFilters,
  limit: number,
  order: "uploaded" | "expiry",
  signal?: AbortSignal,
): Promise<AdminDocument[]> {
  return selectMany(DOCUMENTS_TABLE, adminDocumentSchema, {
    filters: documentFilters(f),
    order:
      order === "expiry"
        ? [
            { column: "expiry_date", ascending: true, nullsFirst: false },
            { column: "uploaded_at", ascending: false },
          ]
        : [{ column: "uploaded_at", ascending: false }],
    limit,
    columns: DOCUMENT_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 3. v_document_compliance — the expiry / compliance register
// -----------------------------------------------------------------------------

export const complianceRowSchema = z.object({
  employee_id: dbUuid,
  employee_code: z.string(),
  display_name: z.string(),
  department_id: dbUuidNullable,
  department_name: z.string().nullable(),
  document_type_id: dbUuid,
  document_type_code: z.string(),
  document_type_name: z.string(),
  requires_expiry: z.boolean(),
  document_id: dbUuidNullable,
  document_status: documentStatusSchema.nullable(),
  expiry_date: dbDateNullable,
  compliance_status: complianceStatusSchema,
});
export type ComplianceRow = z.infer<typeof complianceRowSchema>;

export interface ComplianceFilters {
  readonly statuses?: readonly ComplianceStatus[];
  readonly departmentIds?: readonly string[];
  readonly documentTypeIds?: readonly string[];
  readonly nameLike?: string;
  /** `expiry_date <= this`. A real column filter — the view's own 60-day
   *  `expiring_soon` band is fixed in SQL and is NOT parameterised. */
  readonly expiringOnOrBefore?: string;
}

function complianceFilters(f: ComplianceFilters): Filter[] {
  const filters: Filter[] = [];
  if (f.statuses !== undefined && f.statuses.length > 0)
    filters.push(inList("compliance_status", f.statuses));
  if (f.departmentIds !== undefined && f.departmentIds.length > 0)
    filters.push(inList("department_id", f.departmentIds));
  if (f.documentTypeIds !== undefined && f.documentTypeIds.length > 0)
    filters.push(inList("document_type_id", f.documentTypeIds));
  if (f.nameLike !== undefined && f.nameLike.trim() !== "")
    filters.push(ilike("display_name", `%${f.nameLike.trim()}%`));
  if (f.expiringOnOrBefore !== undefined && f.expiringOnOrBefore !== "")
    filters.push(lte("expiry_date", f.expiringOnOrBefore));
  return filters;
}

/**
 * The compliance register. `v_document_compliance` is one row per
 * (employee × required document type) and has NO single unique column, so it
 * cannot be keyset-paginated; the read is capped and the screen prints the
 * server count beside the cap.
 */
export function fetchCompliance(
  f: ComplianceFilters,
  limit: number,
  signal?: AbortSignal,
): Promise<ComplianceRow[]> {
  return selectMany(V_DOCUMENT_COMPLIANCE, complianceRowSchema, {
    filters: complianceFilters(f),
    order: [
      { column: "expiry_date", ascending: true, nullsFirst: false },
      { column: "display_name", ascending: true },
    ],
    limit,
    ...(signal ? { signal } : {}),
  });
}

export function countCompliance(f: ComplianceFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(V_DOCUMENT_COMPLIANCE, complianceFilters(f), {
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. document_acknowledgements — the outstanding-acknowledgement register
// -----------------------------------------------------------------------------

export const adminAckSchema = z.object({
  id: dbUuid,
  document_id: dbUuid,
  employee_id: dbUuid,
  assigned_at: dbTimestamp,
  due_on: dbDateNullable,
  first_opened_at: dbTimestampNullable,
  open_count: dbInt,
  total_read_seconds: dbInt,
  scroll_completion_pct: dbNumericNullable,
  acknowledged_at: dbTimestampNullable,
  acknowledgement_text: z.string().nullable(),
  status: ackStatusSchema,
  waived_at: dbTimestampNullable,
  waived_reason: z.string().nullable(),
  reminder_count: dbInt,
  last_reminder_at: dbTimestampNullable,
  documents: z
    .object({
      id: dbUuid,
      title: z.string(),
      page_count: dbIntNullable,
      current_version: dbInt,
      document_types: documentTypeRefSchema.nullable(),
    })
    .nullable(),
});
export type AdminAck = z.infer<typeof adminAckSchema>;

const ACK_COLUMNS =
  "id, document_id, employee_id, assigned_at, due_on, first_opened_at, open_count, " +
  "total_read_seconds, scroll_completion_pct, acknowledged_at, acknowledgement_text, " +
  "status, waived_at, waived_reason, reminder_count, last_reminder_at, " +
  "documents(id, title, page_count, current_version, " +
  "document_types(code, name, category, requires_expiry, is_sensitive))";

export interface AckFilters {
  readonly statuses?: readonly AckStatus[];
  readonly employeeId?: string;
  readonly documentId?: string;
  /** `due_on < this` — the overdue predicate, with today passed in from IST. */
  readonly dueBefore?: string;
  /** `due_on <= this`. */
  readonly dueOnOrBefore?: string;
  readonly neverOpenedOnly?: boolean;
}

function ackFilters(f: AckFilters): Filter[] {
  const filters: Filter[] = [];
  if (f.statuses !== undefined && f.statuses.length > 0)
    filters.push(inList("status", f.statuses));
  if (f.employeeId !== undefined && f.employeeId !== "")
    filters.push(eq("employee_id", f.employeeId));
  if (f.documentId !== undefined && f.documentId !== "")
    filters.push(eq("document_id", f.documentId));
  if (f.dueBefore !== undefined && f.dueBefore !== "") filters.push(lt("due_on", f.dueBefore));
  if (f.dueOnOrBefore !== undefined && f.dueOnOrBefore !== "")
    filters.push(lte("due_on", f.dueOnOrBefore));
  if (f.neverOpenedOnly === true) filters.push(isNull("first_opened_at"));
  return filters;
}

/** Outstanding (or decided) acknowledgements, soonest deadline first. */
export function fetchAcknowledgements(
  f: AckFilters,
  limit: number,
  signal?: AbortSignal,
): Promise<AdminAck[]> {
  return selectMany(DOCUMENT_ACKS_TABLE, adminAckSchema, {
    filters: ackFilters(f),
    order: [
      { column: "due_on", ascending: true, nullsFirst: false },
      { column: "assigned_at", ascending: false },
    ],
    limit,
    columns: ACK_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

export function countAcknowledgements(f: AckFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(DOCUMENT_ACKS_TABLE, ackFilters(f), { ...(signal ? { signal } : {}) });
}

/**
 * `v_policy_acknowledgement_status` — assigned / opened / acknowledged / waived /
 * overdue and the acknowledged PERCENTAGE, all counted and rounded by Postgres.
 * Nothing on the screen recomputes any of it.
 */
export const policyAckStatusSchema = z.object({
  document_id: dbUuid,
  document_title: z.string(),
  document_type_code: z.string(),
  document_type_name: z.string(),
  assigned: dbInt,
  opened: dbInt,
  acknowledged: dbInt,
  waived: dbInt,
  overdue: dbInt,
  acknowledged_pct: dbNumericNullable,
  earliest_open_due_on: dbDateNullable,
});
export type PolicyAckStatus = z.infer<typeof policyAckStatusSchema>;

export function fetchPolicyAckStatus(
  limit = 200,
  signal?: AbortSignal,
): Promise<PolicyAckStatus[]> {
  return selectMany(V_POLICY_ACK_STATUS, policyAckStatusSchema, {
    order: [{ column: "document_title", ascending: true }],
    limit,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 5. contract_templates — the letter & contract template register
// -----------------------------------------------------------------------------

/**
 * `contract_templates.variables` is documented as
 * `[{token, label, required, source}]`. It is jsonb, so it is read as `unknown`
 * and narrowed by `templateVariablesOf` — a template with a malformed
 * `variables` array must not take the whole register down.
 */
export const templateVariableSchema = z.object({
  token: z.string(),
  label: z.string().optional(),
  required: z.boolean().optional(),
  source: z.string().optional(),
});
export type TemplateVariable = z.infer<typeof templateVariableSchema>;

const templateVariableArraySchema = z.array(templateVariableSchema);

export function templateVariablesOf(raw: unknown): TemplateVariable[] {
  const parsed = templateVariableArraySchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

/** True when the row declares `variables` but they are not the documented shape. */
export function templateVariablesUnreadable(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  return !templateVariableArraySchema.safeParse(raw).success;
}

export const contractTemplateSchema = z.object({
  id: dbUuid,
  company_id: dbUuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sort_order: dbInt,
  is_active: z.boolean(),
  contract_kind: contractKindSchema,
  body_markdown: z.string(),
  variables: z.unknown(),
  governing_law: z.string(),
  jurisdiction: z.string(),
  requires_witness: z.boolean(),
  version: dbInt,
  is_published: z.boolean(),
  published_at: dbTimestampNullable,
  approved_by_legal_at: dbTimestampNullable,
  deleted_at: dbTimestampNullable,
  created_at: dbTimestamp,
  updated_at: dbTimestamp,
});
export type ContractTemplate = z.infer<typeof contractTemplateSchema>;

const TEMPLATE_COLUMNS =
  "id, company_id, code, name, description, sort_order, is_active, contract_kind, " +
  "body_markdown, variables, governing_law, jurisdiction, requires_witness, version, " +
  "is_published, published_at, approved_by_legal_at, deleted_at, created_at, updated_at";

export interface TemplateFilters {
  readonly kinds?: readonly ContractKind[];
  readonly publishedOnly?: boolean;
  readonly includeInactive?: boolean;
  readonly nameLike?: string;
}

function templateFilters(f: TemplateFilters): Filter[] {
  const filters: Filter[] = [isNull("deleted_at")];
  if (f.includeInactive !== true) filters.push(isTrue("is_active"));
  if (f.publishedOnly === true) filters.push(isTrue("is_published"));
  if (f.kinds !== undefined && f.kinds.length > 0) filters.push(inList("contract_kind", f.kinds));
  if (f.nameLike !== undefined && f.nameLike.trim() !== "")
    filters.push(ilike("name", `%${f.nameLike.trim()}%`));
  return filters;
}

export function fetchContractTemplates(
  f: TemplateFilters = {},
  signal?: AbortSignal,
): Promise<ContractTemplate[]> {
  return selectMany(CONTRACT_TEMPLATES_TABLE, contractTemplateSchema, {
    filters: templateFilters(f),
    order: [
      { column: "sort_order", ascending: true },
      { column: "name", ascending: true },
    ],
    limit: 200,
    columns: TEMPLATE_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

export function countContractTemplates(
  f: TemplateFilters = {},
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(CONTRACT_TEMPLATES_TABLE, templateFilters(f), {
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 6. e_sign_requests / e_sign_signers — the signature-chain register
// -----------------------------------------------------------------------------

export const esignRequestSchema = z.object({
  id: dbUuid,
  request_number: z.string(),
  document_id: dbUuidNullable,
  contract_id: dbUuidNullable,
  subject_employee_id: dbUuidNullable,
  title: z.string(),
  message: z.string().nullable(),
  status: esignStatusSchema,
  signing_order: z.string(),
  expires_at: dbTimestampNullable,
  completed_document_id: dbUuidNullable,
  certificate_hash: z.string().nullable(),
  sent_at: dbTimestampNullable,
  completed_at: dbTimestampNullable,
  cancelled_at: dbTimestampNullable,
  cancelled_reason: z.string().nullable(),
  legal_framework: z.string(),
  created_at: dbTimestamp,
});
export type EsignRequest = z.infer<typeof esignRequestSchema>;

const ESIGN_COLUMNS =
  "id, request_number, document_id, contract_id, subject_employee_id, title, message, " +
  "status, signing_order, expires_at, completed_document_id, certificate_hash, sent_at, " +
  "completed_at, cancelled_at, cancelled_reason, legal_framework, created_at";

export interface EsignFilters {
  readonly statuses?: readonly EsignStatus[];
  readonly employeeId?: string;
  readonly titleLike?: string;
}

function esignFilters(f: EsignFilters): Filter[] {
  const filters: Filter[] = [];
  if (f.statuses !== undefined && f.statuses.length > 0)
    filters.push(inList("status", f.statuses));
  if (f.employeeId !== undefined && f.employeeId !== "")
    filters.push(eq("subject_employee_id", f.employeeId));
  if (f.titleLike !== undefined && f.titleLike.trim() !== "")
    filters.push(ilike("title", `%${f.titleLike.trim()}%`));
  return filters;
}

export function fetchEsignRequests(
  f: EsignFilters,
  limit: number,
  signal?: AbortSignal,
): Promise<EsignRequest[]> {
  return selectMany(ESIGN_REQUESTS_TABLE, esignRequestSchema, {
    filters: esignFilters(f),
    order: [{ column: "created_at", ascending: false }],
    limit,
    columns: ESIGN_COLUMNS,
    ...(signal ? { signal } : {}),
  });
}

export function countEsignRequests(f: EsignFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(ESIGN_REQUESTS_TABLE, esignFilters(f), { ...(signal ? { signal } : {}) });
}

export const esignSignerSchema = z.object({
  id: dbUuid,
  esign_request_id: dbUuid,
  signer_order: dbInt,
  signer_kind: z.string(),
  employee_id: dbUuidNullable,
  full_name: z.string(),
  designation_snapshot: z.string().nullable(),
  identity_check_kind: z.string(),
  identity_verified_at: dbTimestampNullable,
  status: signerStatusSchema,
  notified_at: dbTimestampNullable,
  viewed_at: dbTimestampNullable,
  signed_at: dbTimestampNullable,
  signature_kind: z.string().nullable(),
  declined_reason: z.string().nullable(),
});
export type EsignSigner = z.infer<typeof esignSignerSchema>;

/**
 * The signer chains for the requests on screen. A separate read rather than a
 * PostgREST reverse embed: a delegated signer is re-issued as a NEW row at the
 * same `signer_order` (migration 026 says so), so the chain is a list to render,
 * not a shape to nest — and one failed embed must not blank the register.
 */
export async function fetchEsignSigners(
  requestIds: readonly string[],
  signal?: AbortSignal,
): Promise<EsignSigner[]> {
  if (requestIds.length === 0) return [];
  return selectMany(ESIGN_SIGNERS_TABLE, esignSignerSchema, {
    filters: [inList("esign_request_id", requestIds)],
    order: [
      { column: "esign_request_id", ascending: true },
      { column: "signer_order", ascending: true },
    ],
    limit: requestIds.length * 12,
    columns:
      "id, esign_request_id, signer_order, signer_kind, employee_id, full_name, " +
      "designation_snapshot, identity_check_kind, identity_verified_at, status, " +
      "notified_at, viewed_at, signed_at, signature_kind, declined_reason",
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 7. document_access_log — append-only; who opened what, and why
// -----------------------------------------------------------------------------

export const accessLogSchema = z.object({
  id: dbUuid,
  document_id: dbUuid,
  accessed_by: dbUuid,
  accessed_by_role: z.string().nullable(),
  on_behalf_of: dbUuidNullable,
  access_kind: accessKindSchema,
  purpose: z.string().nullable(),
  ip: z.string().nullable(),
  user_agent: z.string().nullable(),
  device_id: z.string().nullable(),
  signed_url_expires_at: dbTimestampNullable,
  bytes_served: dbIntNullable,
  request_id: dbUuidNullable,
  recorded_at: dbTimestamp,
});
export type AccessLogRow = z.infer<typeof accessLogSchema>;

export interface AccessLogFilters {
  readonly documentId?: string;
  readonly actorId?: string;
  readonly accessKinds?: readonly AccessKind[];
  /** IST-day window as instants (`istRangeInstantBounds`). Upper bound EXCLUSIVE. */
  readonly fromInstant?: string;
  readonly toInstantExclusive?: string;
  readonly withPurposeOnly?: boolean;
}

function accessLogFilters(f: AccessLogFilters): Filter[] {
  const filters: Filter[] = [];
  if (f.documentId !== undefined && f.documentId !== "")
    filters.push(eq("document_id", f.documentId));
  if (f.actorId !== undefined && f.actorId !== "") filters.push(eq("accessed_by", f.actorId));
  if (f.accessKinds !== undefined && f.accessKinds.length > 0)
    filters.push(inList("access_kind", f.accessKinds));
  if (f.fromInstant !== undefined && f.fromInstant !== "")
    filters.push(gte("recorded_at", f.fromInstant));
  if (f.toInstantExclusive !== undefined && f.toInstantExclusive !== "")
    filters.push(lt("recorded_at", f.toInstantExclusive));
  if (f.withPurposeOnly === true) filters.push(isNotNull("purpose"));
  return filters;
}

export function fetchAccessLog(
  f: AccessLogFilters,
  pageSize: number,
  cursor: Cursor | null,
  signal?: AbortSignal,
): Promise<Page<AccessLogRow>> {
  return paginate(DOCUMENT_ACCESS_LOG_TABLE, accessLogSchema, {
    orderBy: "recorded_at",
    ascending: false,
    tiebreak: "id",
    pageSize,
    cursor,
    filters: accessLogFilters(f),
    ...(signal ? { signal } : {}),
  });
}

export function countAccessLog(f: AccessLogFilters, signal?: AbortSignal): Promise<number> {
  return selectCount(DOCUMENT_ACCESS_LOG_TABLE, accessLogFilters(f), {
    ...(signal ? { signal } : {}),
  });
}

/** Titles for the document ids on screen — the log carries no title. */
export async function fetchDocumentTitles(
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await selectMany(
    DOCUMENTS_TABLE,
    z.object({ id: dbUuid, title: z.string() }),
    {
      filters: [inList("id", ids)],
      columns: "id, title",
      limit: ids.length,
      ...(signal ? { signal } : {}),
    },
  );
  return new Map(rows.map((row) => [row.id, row.title]));
}

// -----------------------------------------------------------------------------
// 8. document-generate — the ONLY write path that produces a document
// -----------------------------------------------------------------------------

/**
 * The request body, mirroring `GenerateBody` in
 * `supabase/functions/document-generate/index.ts` exactly. That schema is
 * `.strict()`, so an extra key (a `reason`, for instance) is a 422 — the audit
 * reason travels as `purpose`, which the function also writes to
 * `document_access_log` when it mints a URL.
 */
export interface GenerateInput {
  readonly templateId: string;
  readonly documentTypeId?: string;
  readonly employeeId?: string;
  readonly subjectKind?: SubjectKind;
  readonly companyId?: string;
  readonly title?: string;
  readonly variables?: Readonly<Record<string, string>>;
  readonly issueDate?: string;
  readonly expiryDate?: string;
  readonly tags?: readonly string[];
  readonly isConfidential?: boolean;
  readonly requiresAcknowledgement?: boolean;
  readonly acknowledgementDueOn?: string;
  readonly dryRun: boolean;
  readonly includeDownloadUrl?: boolean;
  /** ≥10 chars. Mandatory when a URL is minted; always sent, always honest. */
  readonly purpose?: string;
}

const generateTemplateRefSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  version: dbInt,
});

/** `dry_run: true` — rendered and measured, nothing written. */
export const generatePreviewSchema = z
  .object({
    dry_run: z.literal(true),
    template: generateTemplateRefSchema,
    document_type: z.object({ id: dbUuid, code: z.string(), name: z.string() }),
    title: z.string(),
    page_count: dbInt,
    file_size_bytes: dbInt,
    checksum_sha256: z.string(),
    variables_resolved: z.record(z.string(), z.string()),
    rendered_markdown: z.string(),
    request_id: z.string(),
  })
  .passthrough();
export type GeneratePreview = z.infer<typeof generatePreviewSchema>;

/** The committed shape — a `documents` row exists after this. */
export const generateCreatedSchema = z
  .object({
    document: z.object({
      id: dbUuid,
      title: z.string(),
      status: documentStatusSchema,
      document_type_code: z.string(),
      storage_bucket: z.string(),
      storage_path: z.string(),
      file_name: z.string(),
      mime_type: z.string(),
      file_size_bytes: dbInt,
      checksum_sha256: z.string(),
      page_count: dbInt,
      version: dbInt,
      requires_acknowledgement: z.boolean(),
      acknowledgement_due_on: dbDateNullable,
      retention_until: dbDateNullable,
    }),
    template: generateTemplateRefSchema,
    contract_id: dbUuidNullable,
    requires_esign: z.boolean(),
    variables_resolved: z.record(z.string(), z.string()),
    download_url: z.string().nullable().optional(),
    download_url_expires_in_seconds: z.number().nullable().optional(),
    request_id: z.string(),
  })
  .passthrough();
export type GenerateCreated = z.infer<typeof generateCreatedSchema>;

export const generateResultSchema = z.union([generatePreviewSchema, generateCreatedSchema]);
export type GenerateResult = z.infer<typeof generateResultSchema>;

export function isGeneratePreview(result: GenerateResult): result is GeneratePreview {
  return "dry_run" in result && result.dry_run === true;
}

/**
 * Render a template into a document. The edge function is the ONLY writer:
 * it refuses an unresolved `{{token}}`, escapes every merge value, refuses text
 * the standard PDF fonts cannot draw, and uploads before writing
 * `documents` + `document_versions` in one transaction.
 *
 * `idempotencyKey` MUST be generated once per form mount and reused across
 * retries — `requireIdempotencyKey` rejects a committing call without one, and a
 * second click with the same key replays the first response instead of
 * generating a second letter.
 */
export function generateDocument(
  input: GenerateInput,
  idempotencyKey?: string,
  signal?: AbortSignal,
): Promise<GenerateResult> {
  const body: Record<string, unknown> = {
    template_id: input.templateId,
    dry_run: input.dryRun,
    variables: input.variables ?? {},
    tags: input.tags ?? [],
    ...(input.documentTypeId !== undefined ? { document_type_id: input.documentTypeId } : {}),
    ...(input.employeeId !== undefined ? { employee_id: input.employeeId } : {}),
    ...(input.subjectKind !== undefined ? { subject_kind: input.subjectKind } : {}),
    ...(input.companyId !== undefined ? { company_id: input.companyId } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.issueDate !== undefined ? { issue_date: input.issueDate } : {}),
    ...(input.expiryDate !== undefined ? { expiry_date: input.expiryDate } : {}),
    ...(input.isConfidential !== undefined ? { is_confidential: input.isConfidential } : {}),
    ...(input.requiresAcknowledgement !== undefined
      ? { requires_acknowledgement: input.requiresAcknowledgement }
      : {}),
    ...(input.acknowledgementDueOn !== undefined
      ? { acknowledgement_due_on: input.acknowledgementDueOn }
      : {}),
    ...(input.includeDownloadUrl !== undefined
      ? { include_download_url: input.includeDownloadUrl }
      : {}),
    ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
  };
  return invokeEdgeFn("document-generate", body, generateResultSchema, {
    idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
    ...(signal ? { signal } : {}),
  });
}

/**
 * The tokens the function said it could not resolve, read off the RFC 9457
 * problem body (`pointer: "/variables/<token>"`, `code: "unresolved_token"`).
 * Returned so the form can put an input next to each one instead of showing a
 * paragraph the admin has to decode.
 */
const problemErrorsSchema = z.object({
  errors: z.array(
    z.object({
      pointer: z.string().optional(),
      code: z.string().optional(),
      detail: z.string().optional(),
    }),
  ),
});

export function unresolvedTokensOf(problem: unknown): string[] {
  const parsed = problemErrorsSchema.safeParse(problem);
  if (!parsed.success) return [];
  const out: string[] = [];
  for (const item of parsed.data.errors) {
    if (item.code !== "unresolved_token") continue;
    const pointer = item.pointer ?? "";
    if (!pointer.startsWith("/variables/")) continue;
    // RFC 6901 escapes, in the order the spec requires.
    const token = pointer.slice("/variables/".length).replace(/~1/g, "/").replace(/~0/g, "~");
    if (token !== "" && !out.includes(token)) out.push(token);
  }
  return out;
}
