/**
 * audit.api.ts — Audit & Compliance console (§13). READS ONLY, by construction.
 *
 * `audit_log` is append-only: UPDATE and DELETE are revoked from every app role
 * and a BEFORE trigger raises unconditionally (D-20). There is therefore no write
 * function in this module and there never should be — the only "write" the
 * console performs is an EXPORT, which goes through the `export-audit` edge
 * function so the export itself is audited.
 *
 * Two read paths, deliberately different:
 *   * `audit_log` for the timeline (`/admin/audit`) — every entity, every actor,
 *     hash-chained, with `ist_timestamp` already computed by the database.
 *   * `v_audit_trail_employee` for a person's history (360 tab 13,
 *     `/admin/audit/entity/...`) — the same rows joined to employee identity and
 *     pre-rendered `occurred_at_ist`.
 *
 * Redaction is the server's: `is_redacted` rows carry `***` in `old_value` /
 * `new_value` plus a hash. The client never has the real value to leak, and
 * revealing one is a super-admin RPC that writes its own data-access row.
 */
import { z } from "zod";
import {
  dbDate,
  dbDateNullable,
  dbInt,
  dbIntNullable,
  dbTimestamp,
  dbUuid,
  dbUuidNullable,
  eq,
  gte,
  ilike,
  inList,
  lte,
  paginate,
  selectMany,
  selectOne,
  type Cursor,
  type Filter,
  type Page,
} from "@/shared/api/query";
import { invokeEdgeFn, newIdempotencyKey } from "@/shared/api/invoke";
import { SENSITIVE_REASON_LENGTH, assertReason } from "@/shared/api/query";

export const AUDIT_LOG_TABLE = "audit_log";
export const V_AUDIT_TRAIL_EMPLOYEE = "v_audit_trail_employee";
export const V_MY_DATA_ACCESS = "v_my_data_access";
export const V_DOCUMENT_COMPLIANCE = "v_document_compliance";

/**
 * `public.audit_action` — the DEPLOYED enum (migration 003). Verified against the
 * live project: filtering on 'reveal' or 'read' returns 22P02 'invalid input
 * value for enum audit_action', because those names do not exist here. The
 * sensitive-read action is `read_sensitive`.
 */
export const auditActionValues = [
  "insert",
  "update",
  "delete",
  "soft_delete",
  "restore",
  "hard_delete",
  "login",
  "logout",
  "login_failed",
  "read_sensitive",
  "export",
  "approve",
  "reject",
  "cancel",
  "void",
  "override",
  "recompute",
  "lock",
  "unlock",
  "send",
  "sign",
  "enrol_biometric",
  "purge_biometric",
  "grant_role",
  "revoke_role",
  "impersonate",
  "config_change",
  "job_run",
] as const;
export const auditActionSchema = z.enum(auditActionValues);
export type AuditAction = z.infer<typeof auditActionSchema>;

// -----------------------------------------------------------------------------
// 1. Audit timeline (`/admin/audit`)
// -----------------------------------------------------------------------------

export const auditRowSchema = z.object({
  id: dbUuid,
  occurred_at: dbTimestamp,
  /** IST wall clock, computed by the database (generated column). */
  ist_timestamp: z.string(),
  ist_date: dbDate,
  seq: dbInt,
  actor_id: dbUuidNullable,
  actor_employee_id: dbUuidNullable,
  actor_role: z.string().nullable(),
  actor_email: z.string().nullable(),
  actor_source: z.string(),
  on_behalf_of: dbUuidNullable,
  impersonated_by: dbUuidNullable,
  action: z.string(),
  entity_table: z.string(),
  entity_id: dbUuidNullable,
  /** Denormalised human label, e.g. 'TT0003 — Ravi Kumar'. */
  entity_label: z.string().nullable(),
  subject_employee_id: dbUuidNullable,
  field_name: z.string().nullable(),
  /** jsonb. `***` when `is_redacted` — the real value never reaches the client. */
  old_value: z.unknown().nullable(),
  new_value: z.unknown().nullable(),
  is_redacted: z.boolean(),
  reason: z.string().nullable(),
  source: z.string().nullable(),
  request_id: dbUuidNullable,
  ip: z.string().nullable(),
  user_agent: z.string().nullable(),
  device_id: z.string().nullable(),
  session_id: z.string().nullable(),
  approval_request_id: dbUuidNullable,
  prev_hash: z.string().nullable(),
  row_hash: z.string(),
  chain_id: z.string(),
});
export type AuditRow = z.infer<typeof auditRowSchema>;

export interface AuditFilters {
  readonly from?: string;
  readonly to?: string;
  readonly actorIds?: readonly string[];
  readonly actorRoles?: readonly string[];
  readonly subjectEmployeeIds?: readonly string[];
  readonly entityTables?: readonly string[];
  readonly entityId?: string;
  readonly actions?: readonly string[];
  readonly sources?: readonly string[];
  readonly fieldName?: string;
  /** §13.2 "Has reason" — audits that carried a justification. */
  readonly onlyWithReason?: boolean;
  /** Substring search over the entity label (the cheap half of free text). */
  readonly labelLike?: string;
  /**
   * Substring search over the written reason (§13.2 free text). Kept separate
   * from `labelLike` because the filter vocabulary is AND-only by design — an OR
   * across both columns would need raw PostgREST syntax, which `Filter` refuses
   * on purpose. The Audit Timeline exposes them as two distinct search boxes so
   * what the admin typed and what the server matched are the same thing.
   */
  readonly reasonLike?: string;
  /** Substring over `field_name` — 'salary', 'aadhaar', 'status'. */
  readonly fieldLike?: string;
  readonly redactedOnly?: boolean;
}

function auditFilters(f: AuditFilters): Filter[] {
  const filters: Filter[] = [];
  if (f.from !== undefined) filters.push(gte("ist_date", f.from));
  if (f.to !== undefined) filters.push(lte("ist_date", f.to));
  if (f.actorIds && f.actorIds.length > 0) filters.push(inList("actor_id", f.actorIds));
  if (f.actorRoles && f.actorRoles.length > 0) filters.push(inList("actor_role", f.actorRoles));
  if (f.subjectEmployeeIds && f.subjectEmployeeIds.length > 0)
    filters.push(inList("subject_employee_id", f.subjectEmployeeIds));
  if (f.entityTables && f.entityTables.length > 0) filters.push(inList("entity_table", f.entityTables));
  if (f.entityId !== undefined) filters.push(eq("entity_id", f.entityId));
  if (f.actions && f.actions.length > 0) filters.push(inList("action", f.actions));
  if (f.sources && f.sources.length > 0) filters.push(inList("actor_source", f.sources));
  if (f.fieldName !== undefined) filters.push(eq("field_name", f.fieldName));
  if (f.onlyWithReason === true) filters.push({ op: "not_is", column: "reason", value: null });
  if (f.labelLike !== undefined && f.labelLike.trim() !== "")
    filters.push(ilike("entity_label", `%${f.labelLike.trim()}%`));
  if (f.reasonLike !== undefined && f.reasonLike.trim() !== "")
    filters.push(ilike("reason", `%${f.reasonLike.trim()}%`));
  if (f.fieldLike !== undefined && f.fieldLike.trim() !== "")
    filters.push(ilike("field_name", `%${f.fieldLike.trim()}%`));
  if (f.redactedOnly === true) filters.push({ op: "is", column: "is_redacted", value: true });
  return filters;
}

/**
 * Keyset page of the timeline, newest first. `seq` is the tiebreak because it is
 * the chain's own monotonic counter — paging an append-only log by OFFSET while
 * it is being written is exactly the defect keyset paging exists to avoid.
 */
export function fetchAuditTimeline(
  f: AuditFilters,
  pageSize: number,
  cursor: Cursor | null,
  signal?: AbortSignal,
): Promise<Page<AuditRow>> {
  return paginate(AUDIT_LOG_TABLE, auditRowSchema, {
    orderBy: "occurred_at",
    ascending: false,
    tiebreak: "seq",
    pageSize,
    cursor,
    filters: auditFilters(f),
    ...(signal ? { signal } : {}),
  });
}

/** One event — the diff viewer (`/admin/audit/diff/:eventId`). */
export function fetchAuditEvent(eventId: string, signal?: AbortSignal): Promise<AuditRow | null> {
  return selectOne(AUDIT_LOG_TABLE, auditRowSchema, [eq("id", eventId)], {
    ...(signal ? { signal } : {}),
  });
}

/**
 * The other field-changes written in the same statement, so the diff viewer can
 * show a whole edit rather than one column of it. Grouped by `request_id`, which
 * the write layer sets from `x-request-id` on every audited mutation.
 */
export function fetchAuditEventGroup(
  requestId: string,
  signal?: AbortSignal,
): Promise<AuditRow[]> {
  return selectMany(AUDIT_LOG_TABLE, auditRowSchema, {
    filters: [eq("request_id", requestId)],
    order: [{ column: "seq", ascending: true }],
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

/** Every event on one entity — `/admin/audit/entity/:type/:id`. */
export function fetchEntityHistory(
  entityTable: string,
  entityId: string,
  pageSize: number,
  cursor: Cursor | null,
  signal?: AbortSignal,
): Promise<Page<AuditRow>> {
  return paginate(AUDIT_LOG_TABLE, auditRowSchema, {
    orderBy: "occurred_at",
    ascending: false,
    tiebreak: "seq",
    pageSize,
    cursor,
    filters: [eq("entity_table", entityTable), eq("entity_id", entityId)],
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 2. Employee record history (360 tab 13)
// -----------------------------------------------------------------------------

export const employeeAuditRowSchema = z.object({
  id: dbUuid,
  subject_employee_id: dbUuid,
  subject_employee_code: z.string(),
  subject_display_name: z.string(),
  occurred_at: dbTimestamp,
  ist_timestamp: z.string(),
  /** Pre-rendered by the view, e.g. '26 Jul 2026 11:39:18'. */
  occurred_at_ist: z.string(),
  actor_id: dbUuidNullable,
  actor_name: z.string().nullable(),
  actor_role: z.string().nullable(),
  actor_source: z.string(),
  action: z.string(),
  entity_table: z.string(),
  entity_id: dbUuidNullable,
  entity_label: z.string().nullable(),
  field_name: z.string().nullable(),
  old_value: z.unknown().nullable(),
  new_value: z.unknown().nullable(),
  is_redacted: z.boolean(),
  reason: z.string().nullable(),
  approval_request_id: dbUuidNullable,
  request_id: dbUuidNullable,
});
export type EmployeeAuditRow = z.infer<typeof employeeAuditRowSchema>;

export function fetchEmployeeAuditTrail(
  employeeId: string,
  f: { from?: string; to?: string; fieldName?: string; onlyWithReason?: boolean },
  pageSize: number,
  cursor: Cursor | null,
  signal?: AbortSignal,
): Promise<Page<EmployeeAuditRow>> {
  const filters: Filter[] = [eq("subject_employee_id", employeeId)];
  if (f.from !== undefined) filters.push(gte("occurred_at", f.from));
  if (f.to !== undefined) filters.push(lte("occurred_at", f.to));
  if (f.fieldName !== undefined) filters.push(eq("field_name", f.fieldName));
  if (f.onlyWithReason === true) filters.push({ op: "not_is", column: "reason", value: null });
  return paginate(V_AUDIT_TRAIL_EMPLOYEE, employeeAuditRowSchema, {
    orderBy: "occurred_at",
    ascending: false,
    tiebreak: "id",
    pageSize,
    cursor,
    filters,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 3. Data-access audit (`/admin/audit/data-access`) — who read what, and why
// -----------------------------------------------------------------------------

/**
 * The employee-facing transparency view (`v_my_data_access`), column for column
 * from migration 037: the timestamp column is `accessed_at`, NOT `occurred_at`,
 * and the actor is `accessed_by` (a resolved name). Verified live — asking for
 * `occurred_at` returns 42703.
 */
export const myDataAccessRowSchema = z.object({
  id: dbUuid,
  accessed_at: dbTimestamp,
  /** Pre-rendered IST, e.g. '26 Jul 2026 11:39'. */
  accessed_at_ist: z.string(),
  accessed_by: z.string(),
  actor_role: z.string().nullable(),
  actor_source: z.string(),
  entity_table: z.string(),
  fields: z.array(z.string()),
  access_kind: z.string(),
  /** The written purpose — the reason the reveal was allowed at all. */
  purpose: z.string(),
  record_count: dbIntNullable,
});
export type MyDataAccessRow = z.infer<typeof myDataAccessRowSchema>;

export function fetchMyDataAccess(
  f: { from?: string; to?: string } = {},
  limit = 200,
  signal?: AbortSignal,
): Promise<MyDataAccessRow[]> {
  const filters: Filter[] = [];
  if (f.from !== undefined) filters.push(gte("accessed_at", f.from));
  if (f.to !== undefined) filters.push(lte("accessed_at", f.to));
  return selectMany(V_MY_DATA_ACCESS, myDataAccessRowSchema, {
    filters,
    order: [{ column: "accessed_at", ascending: false }],
    limit,
    ...(signal ? { signal } : {}),
  });
}

/**
 * The admin-wide data-access register (`/admin/audit/data-access`, §13.5).
 *
 * This is its OWN append-only table — `data_access_log`, admin-readable via
 * `data_access_log__admin_read` — not a filtered slice of `audit_log`. Every
 * reveal RPC writes a row here through `app.log_reveal()`, which is why the
 * register can answer "who read this employee's Aadhaar, and why".
 */
export const dataAccessRowSchema = z.object({
  id: dbUuid,
  accessed_at: dbTimestamp,
  ist_date: dbDate,
  actor_id: dbUuidNullable,
  actor_role: z.string().nullable(),
  actor_source: z.string(),
  on_behalf_of: dbUuidNullable,
  entity_table: z.string(),
  entity_id: dbUuidNullable,
  subject_employee_id: dbUuidNullable,
  /** Which fields were exposed, e.g. {pan,aadhaar_number}. */
  fields: z.array(z.string()),
  /** 'viewed' | 'revealed' | 'downloaded' | 'exported' | … */
  access_kind: z.string(),
  purpose: z.string(),
  record_count: dbIntNullable,
  filter_summary: z.unknown().nullable(),
  ip: z.string().nullable(),
  user_agent: z.string().nullable(),
  device_id: z.string().nullable(),
  request_id: dbUuidNullable,
  recorded_at: dbTimestamp,
});
export type DataAccessRow = z.infer<typeof dataAccessRowSchema>;

export const DATA_ACCESS_LOG_TABLE = "data_access_log";

export interface DataAccessFilters {
  readonly from?: string;
  readonly to?: string;
  readonly actorIds?: readonly string[];
  readonly subjectEmployeeIds?: readonly string[];
  readonly entityTables?: readonly string[];
  readonly accessKinds?: readonly string[];
}

export function fetchDataAccessRegister(
  f: DataAccessFilters,
  pageSize: number,
  cursor: Cursor | null,
  signal?: AbortSignal,
): Promise<Page<DataAccessRow>> {
  const filters: Filter[] = [];
  if (f.from !== undefined) filters.push(gte("ist_date", f.from));
  if (f.to !== undefined) filters.push(lte("ist_date", f.to));
  if (f.actorIds && f.actorIds.length > 0) filters.push(inList("actor_id", f.actorIds));
  if (f.subjectEmployeeIds && f.subjectEmployeeIds.length > 0)
    filters.push(inList("subject_employee_id", f.subjectEmployeeIds));
  if (f.entityTables && f.entityTables.length > 0) filters.push(inList("entity_table", f.entityTables));
  if (f.accessKinds && f.accessKinds.length > 0) filters.push(inList("access_kind", f.accessKinds));
  return paginate(DATA_ACCESS_LOG_TABLE, dataAccessRowSchema, {
    orderBy: "accessed_at",
    ascending: false,
    tiebreak: "id",
    pageSize,
    cursor,
    filters,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. Document compliance (§9 / E1) — a compliance read, not a document CRUD
// -----------------------------------------------------------------------------

export const documentComplianceRowSchema = z.object({
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
  document_status: z.string().nullable(),
  expiry_date: dbDateNullable,
  /** 'missing' | 'expired' | 'expiring' | 'valid' — the server's verdict. */
  compliance_status: z.string(),
});
export type DocumentComplianceRow = z.infer<typeof documentComplianceRowSchema>;

export function fetchDocumentCompliance(
  f: {
    statuses?: readonly string[];
    departmentIds?: readonly string[];
    /** One person's row set — the Employee 360 Documents tab (§2 tab 7). */
    employeeIds?: readonly string[];
  } = {},
  limit = 500,
  signal?: AbortSignal,
): Promise<DocumentComplianceRow[]> {
  const filters: Filter[] = [];
  if (f.statuses && f.statuses.length > 0) filters.push(inList("compliance_status", f.statuses));
  if (f.departmentIds && f.departmentIds.length > 0) filters.push(inList("department_id", f.departmentIds));
  if (f.employeeIds && f.employeeIds.length > 0) filters.push(inList("employee_id", f.employeeIds));
  return selectMany(V_DOCUMENT_COMPLIANCE, documentComplianceRowSchema, {
    filters,
    order: [
      { column: "employee_code", ascending: true },
      { column: "document_type_code", ascending: true },
    ],
    limit,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 5. Export — the one action, and it is itself audited
// -----------------------------------------------------------------------------

const exportResultSchema = z
  .object({
    download_url: z.string().optional(),
    row_count: z.number().optional(),
    content_hash: z.string().optional(),
    expires_at: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * `export-audit` produces the evidence pack. The reason is mandatory and long
 * (D-21): an audit export is a PII egress event, recorded in the Export Register
 * with the filter set, the row count and a content hash.
 */
export function exportAuditTrail(
  f: AuditFilters,
  reason: string,
  idempotencyKey?: string,
): Promise<z.infer<typeof exportResultSchema>> {
  const validated = assertReason(reason, {
    table: "export-audit",
    minLength: SENSITIVE_REASON_LENGTH,
  });
  return invokeEdgeFn(
    "export-audit",
    { filters: f, reason: validated },
    exportResultSchema,
    { idempotencyKey: idempotencyKey ?? newIdempotencyKey() },
  );
}
