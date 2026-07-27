/**
 * governance.api.ts — the reads behind the DPDP pack (§13.7) and the retention
 * console (§13.8).
 *
 * WHAT IS ACTUALLY IN THE DATABASE, and therefore what these two screens can
 * state. Each item was read out of the migrations:
 *
 *  * RETENTION POLICY PER ENTITY — `public.document_types.retention_years` +
 *    `retention_basis` (CHECK: from_upload | from_exit | from_expiry |
 *    indefinite), migration 025 §1. This is the only per-entity retention
 *    schedule that exists as DATA rather than as prose in a spec.
 *  * WHAT IS DUE — `public.documents.retention_until` (a `date`, migration 025
 *    §2). A row whose `retention_until` has passed is due; a row with NULL has
 *    never been stamped, which is its own compliance gap and is counted
 *    separately rather than being read as "keep forever".
 *  * WHAT THE JOB DID — `public.job_runs`, including the `result` jsonb that
 *    `public.retention_sweep()` returns: `face_scores_nulled`,
 *    `challenges_purged`, `idempotency_keys_purged` (migration 031 §8). The
 *    projection in `health.api.ts` deliberately drops `result`, so this module
 *    reads it for the one screen whose whole point is the evidence.
 *  * WHO READ WHAT, AND WHY — `public.data_access_log` (§4.4, migration 006):
 *    `access_kind` CHECK = reveal | export | report | ai_query | bulk_view, and
 *    `purpose` has a `length(btrim(purpose)) >= 10` CHECK, so a purpose-free read
 *    cannot exist. Counting by kind is the DPDP "purpose limitation" evidence.
 *  * WHAT LEFT THE BUILDING — `public.export_log.contains_pii` /
 *    `contains_salary` / `contains_biometric` (migration 006 §3).
 *
 * WHAT IS NOT IN THE DATABASE, and is therefore never faked:
 *  * no `data_subject_requests` table — DSR intake/SLA has no store, and no
 *    `request_types` row covers it either (migration 045 seeds 18 types, none of
 *    them a data-subject request);
 *  * no `breach_log`, no `processing_purposes` (RoPA) table;
 *  * no `retention_policies` table — retention beyond `document_types` lives in
 *    two `settings` keys and in constants INSIDE `public.retention_sweep()`;
 *  * `retention_sweep()` grants EXECUTE to `service_role` ONLY (migration 031 §9
 *    grants), so a browser cannot trigger it however senior the operator is.
 *
 * Nothing here computes a retention date. `retention_until` is a server column;
 * the only comparison made anywhere is `retention_until <= today`, and Postgres
 * makes it.
 */
import { z } from "zod";
import {
  dbDate,
  dbDateNullable,
  dbInt,
  dbIntNullable,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  gte,
  inList,
  isNotNull,
  isNull,
  isTrue,
  lte,
  selectCount,
  selectMany,
  type Filter,
} from "@/shared/api/query";
import { DATA_ACCESS_LOG_TABLE } from "./audit.api";
import { EXPORT_LOG_TABLE } from "./audit-registers.api";

export const DOCUMENT_TYPES_TABLE = "document_types";
export const DOCUMENTS_TABLE = "documents";
export const JOB_RUNS_TABLE = "job_runs";

// -----------------------------------------------------------------------------
// 1. Retention schedule per document type
// -----------------------------------------------------------------------------

/** `ck_document_types__retention_basis`, verbatim. */
export const retentionBasisValues = [
  "from_upload",
  "from_exit",
  "from_expiry",
  "indefinite",
] as const;
export type RetentionBasis = (typeof retentionBasisValues)[number];

export const retentionClassSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  category: z.string(),
  retention_years: dbInt,
  retention_basis: z.string(),
  is_sensitive: z.boolean(),
  requires_expiry: z.boolean(),
  is_active: z.boolean(),
});
export type RetentionClass = z.infer<typeof retentionClassSchema>;

/**
 * The per-entity retention schedule, ordered as an auditor reads it: longest
 * retention first, because the rows that never age out are the ones a DPDP
 * reviewer asks about.
 */
export function fetchRetentionClasses(
  limit = 100,
  signal?: AbortSignal,
): Promise<RetentionClass[]> {
  return selectMany(DOCUMENT_TYPES_TABLE, retentionClassSchema, {
    filters: [isNull("deleted_at")],
    order: [
      { column: "retention_years", ascending: false },
      { column: "category", ascending: true },
      { column: "code", ascending: true },
    ],
    columns:
      "id,code,name,category,retention_years,retention_basis,is_sensitive,requires_expiry,is_active",
    limit,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 2. Documents against their retention date
// -----------------------------------------------------------------------------

export const retentionDueDocumentSchema = z.object({
  id: dbUuid,
  title: z.string(),
  document_type_id: dbUuid,
  employee_id: dbUuidNullable,
  subject_kind: z.string(),
  status: z.string(),
  retention_until: dbDate,
  expiry_date: dbDateNullable,
  archived_at: dbTimestampNullable,
  uploaded_at: dbTimestamp,
  is_confidential: z.boolean(),
});
export type RetentionDueDocument = z.infer<typeof retentionDueDocumentSchema>;

const DUE_DOCUMENT_COLUMNS =
  "id,title,document_type_id,employee_id,subject_kind,status,retention_until,expiry_date,archived_at,uploaded_at,is_confidential";

/** Live documents whose retention date has passed — the purge candidate list. */
function dueFilters(today: string): Filter[] {
  return [isNull("deleted_at"), isNotNull("retention_until"), lte("retention_until", today)];
}

export function fetchDocumentsDueForPurge(
  today: string,
  limit = 100,
  signal?: AbortSignal,
): Promise<RetentionDueDocument[]> {
  return selectMany(DOCUMENTS_TABLE, retentionDueDocumentSchema, {
    filters: dueFilters(today),
    order: [{ column: "retention_until", ascending: true }],
    columns: DUE_DOCUMENT_COLUMNS,
    limit,
    ...(signal ? { signal } : {}),
  });
}

/** The SAME predicate as the list, counted by Postgres (DR-29). */
export function countDocumentsDueForPurge(today: string, signal?: AbortSignal): Promise<number> {
  return selectCount(DOCUMENTS_TABLE, dueFilters(today), { ...(signal ? { signal } : {}) });
}

/** Live documents in the vault, whatever their retention state. */
export function countLiveDocuments(signal?: AbortSignal): Promise<number> {
  return selectCount(DOCUMENTS_TABLE, [isNull("deleted_at")], { ...(signal ? { signal } : {}) });
}

/**
 * Live documents with NO `retention_until`. Not "keep forever" — unstamped. The
 * retention screen shows this next to the due count because a retention policy
 * that was never applied to a row cannot expire it.
 */
export function countDocumentsWithoutRetentionDate(signal?: AbortSignal): Promise<number> {
  return selectCount(DOCUMENTS_TABLE, [isNull("deleted_at"), isNull("retention_until")], {
    ...(signal ? { signal } : {}),
  });
}

/** Documents already archived (`archived_at`) — retention that has been acted on. */
export function countArchivedDocuments(signal?: AbortSignal): Promise<number> {
  return selectCount(DOCUMENTS_TABLE, [isNull("deleted_at"), isNotNull("archived_at")], {
    ...(signal ? { signal } : {}),
  });
}

export interface DocumentRetentionCounts {
  readonly live: number;
  readonly due: number;
  readonly unstamped: number;
  readonly archived: number;
}

/** Four server COUNTs, one round of requests, no client arithmetic. */
export async function fetchDocumentRetentionCounts(
  today: string,
  signal?: AbortSignal,
): Promise<DocumentRetentionCounts> {
  const [live, due, unstamped, archived] = await Promise.all([
    countLiveDocuments(signal),
    countDocumentsDueForPurge(today, signal),
    countDocumentsWithoutRetentionDate(signal),
    countArchivedDocuments(signal),
  ]);
  return { live, due, unstamped, archived };
}

// -----------------------------------------------------------------------------
// 3. Retention job runs — with the result payload
// -----------------------------------------------------------------------------

/**
 * `retention_sweep()` returns
 * `{face_scores_nulled, challenges_purged, idempotency_keys_purged}`. Each key is
 * optional here because the edge-function half of the sweep writes its own shape,
 * and `passthrough` keeps anything else the server chose to record instead of
 * dropping it silently.
 */
export const retentionResultSchema = z
  .object({
    face_scores_nulled: dbIntNullable.optional(),
    challenges_purged: dbIntNullable.optional(),
    idempotency_keys_purged: dbIntNullable.optional(),
  })
  .passthrough();
export type RetentionResult = z.infer<typeof retentionResultSchema>;

export const retentionRunSchema = z.object({
  id: dbUuid,
  job_code: z.string(),
  run_kind: z.string(),
  status: z.string(),
  started_at: dbTimestamp,
  finished_at: dbTimestampNullable,
  duration_ms: dbIntNullable,
  records_processed: dbIntNullable,
  records_failed: dbIntNullable,
  /** The sweep's own report. Absent on a run that failed before returning. */
  result: retentionResultSchema.nullable(),
  error: z.string().nullable(),
  attempt: dbInt,
});
export type RetentionRun = z.infer<typeof retentionRunSchema>;

/** Run history for the named jobs, newest first, with the result payload. */
export function fetchRetentionRuns(
  jobCodes: readonly string[],
  limit = 50,
  signal?: AbortSignal,
): Promise<RetentionRun[]> {
  const filters: Filter[] = jobCodes.length > 0 ? [inList("job_code", jobCodes)] : [];
  return selectMany(JOB_RUNS_TABLE, retentionRunSchema, {
    filters,
    order: [{ column: "started_at", ascending: false }],
    columns:
      "id,job_code,run_kind,status,started_at,finished_at,duration_ms,records_processed,records_failed,result,error,attempt",
    limit,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. DPDP: purpose-logged access, by kind
// -----------------------------------------------------------------------------

/** `ck_dalog__kind` — the five access kinds the log accepts, verbatim. */
export const accessKindValues = ["reveal", "export", "report", "ai_query", "bulk_view"] as const;
export type AccessKind = (typeof accessKindValues)[number];

export type AccessKindCounts = Readonly<Record<AccessKind, number>>;

/**
 * How many purpose-logged accesses of each kind happened in an IST civil-date
 * window. `ist_date` is a STORED generated column (`util.ist_date(accessed_at)`),
 * so filtering on it is an IST business-date filter, not a UTC one.
 */
export async function fetchAccessKindCounts(
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<AccessKindCounts> {
  const base: Filter[] = [gte("ist_date", from), lte("ist_date", to)];
  const counts = await Promise.all(
    accessKindValues.map((kind) =>
      selectCount(DATA_ACCESS_LOG_TABLE, [...base, eq("access_kind", kind)], {
        ...(signal ? { signal } : {}),
      }),
    ),
  );
  const out: Record<string, number> = {};
  accessKindValues.forEach((kind, index) => {
    out[kind] = counts[index] ?? 0;
  });
  return out as AccessKindCounts;
}

/** Subjects whose data was accessed in the window, as a server COUNT of rows. */
export function countAccessRows(
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<number> {
  return selectCount(DATA_ACCESS_LOG_TABLE, [gte("ist_date", from), lte("ist_date", to)], {
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 5. DPDP: egress that carried personal data
// -----------------------------------------------------------------------------

export interface EgressCounts {
  readonly total: number;
  readonly pii: number;
  readonly salary: number;
  readonly biometric: number;
}

/**
 * Exports in the window, and how many carried each class of personal data.
 * `exported_at` is a `timestamptz`, so the bounds are INSTANTS — callers pass
 * `istRangeInstantBounds`, never a bare civil date (a date literal would pin the
 * comparison to 00:00 UTC and drop the first five and a half hours of every IST
 * day).
 */
export async function fetchEgressCounts(
  fromInstant: string,
  toInstant: string,
  signal?: AbortSignal,
): Promise<EgressCounts> {
  const base: Filter[] = [gte("exported_at", fromInstant), lte("exported_at", toInstant)];
  const [total, pii, salary, biometric] = await Promise.all([
    selectCount(EXPORT_LOG_TABLE, base, { ...(signal ? { signal } : {}) }),
    selectCount(EXPORT_LOG_TABLE, [...base, isTrue("contains_pii")], { ...(signal ? { signal } : {}) }),
    selectCount(EXPORT_LOG_TABLE, [...base, isTrue("contains_salary")], {
      ...(signal ? { signal } : {}),
    }),
    selectCount(EXPORT_LOG_TABLE, [...base, isTrue("contains_biometric")], {
      ...(signal ? { signal } : {}),
    }),
  ]);
  return { total, pii, salary, biometric };
}
