/**
 * imports.api.ts — CSV bulk employee import (spec-admin §3.4), driven end to end
 * by the DEPLOYED `employee-import` edge function.
 *
 * The function is the whole importer; this file is a thin, honest driver for it.
 * Two transports, because the function has two:
 *
 *   STAGE  · `multipart/form-data` with the CSV as the `file` part → the function
 *            parses every cell AS TEXT, validates it, writes `import_batches`
 *            (`status = 'validated'`, `dry_run = true`) plus one `import_rows` row
 *            per CSV line holding the exact source text, and answers with the
 *            reconciliation report. NOTHING reaches `public.employees`.
 *   COMMIT · `application/json` `{ mode: 'commit', batchId, reason }` → the SAME
 *            validator runs again over the stored raw cells, then the employees
 *            and their satellites are inserted in 200-row transactions.
 *
 * Why a local multipart poster instead of `invokeEdgeFn`: that helper is
 * `JSON.stringify`-only by contract, and a CSV must arrive as bytes — re-encoding
 * it as a JSON string is exactly the kind of round trip through a parser that
 * `1.0202E+11` came out of. Everything else is shared with it: the same
 * `Idempotency-Key` + `x-idempotency-key` pair, the same RFC 9457 problem
 * decoding, the same `TTApiError` so `isStepUpRequired()` and
 * `mutationUserMessage()` behave identically on both paths.
 *
 * `employee.import` carries `requires_step_up` in `role_capabilities`, so an
 * aal1 session is refused with `MFA_STEP_UP_REQUIRED` — the caller is expected to
 * run `useStepUp().ensureAal2()` and retry the identical idempotent call.
 *
 * Column truth: `IMPORT_COLUMNS` mirrors `COLUMNS` in
 * `supabase/functions/employee-import/index.ts` field for field (67 columns,
 * declaration order, primary alias, required flag). It is a REFERENCE, not a
 * second validator — the function rejects an unknown header outright, so a screen
 * that offered a column the function does not know would be lying to the user
 * before the upload even happened.
 */
import { z } from "zod";
import {
  TTApiError,
  invokeEdgeFn,
  newIdempotencyKey,
  problemSchema,
} from "@/shared/api/invoke";
import {
  dbInt,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  inList,
  selectCount,
  selectMany,
  type Filter,
} from "@/shared/api/query";
import { supabase } from "@/lib/supabase";
import { env } from "@/lib/env";

export const EMPLOYEE_IMPORT_FN = "employee-import";
export const IMPORT_BATCHES_TABLE = "import_batches";
export const IMPORT_ROWS_TABLE = "import_rows";

/** `import_batches.import_kind` — the one kind this function owns. */
export const IMPORT_KIND_EMPLOYEES = "employees";

/** `MAX_FILE_BYTES` / `MAX_ROWS` in the edge function — refuse before uploading. */
export const MAX_IMPORT_FILE_BYTES = 6 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5_000;

/** `StageFields.delimiter` — the function accepts exactly these three. */
export const IMPORT_DELIMITERS = [",", ";", "\t"] as const;
export type ImportDelimiter = (typeof IMPORT_DELIMITERS)[number];

// -----------------------------------------------------------------------------
// 1. The batch register (`import_batches`, migration 031 §6)
// -----------------------------------------------------------------------------

/**
 * `ck_import_batches__status`. `validated` is a staged dry run; `importing` is a
 * commit that ran out of wall clock and can be resumed; `rolled_back` can only
 * be reached by a server path that does not exist yet (see the page header).
 */
export const importBatchStatuses = [
  "uploaded",
  "validating",
  "validated",
  "importing",
  "completed",
  "failed",
  "rolled_back",
] as const;
export type ImportBatchStatus = (typeof importBatchStatuses)[number];

export const importBatchSchema = z.object({
  id: dbUuid,
  import_kind: z.string(),
  original_file_name: z.string().nullable(),
  row_count: dbInt,
  valid_count: dbInt,
  invalid_count: dbInt,
  imported_count: dbInt,
  status: z.string(),
  /** True until a commit flips it — a staged batch has written no employee. */
  dry_run: z.boolean(),
  /** Company, delimiter, header→field map, source object and checksums. */
  mapping: z.unknown().nullable(),
  uploaded_by: dbUuidNullable,
  validated_at: dbTimestampNullable,
  imported_at: dbTimestampNullable,
  rollback_at: dbTimestampNullable,
  error_summary: z.unknown().nullable(),
  created_at: dbTimestamp,
});
export type ImportBatch = z.infer<typeof importBatchSchema>;

/** `error_summary` as the function writes it: counts by code, plus warnings. */
export const importErrorSummarySchema = z
  .object({
    by_code: z.record(z.number()).nullable().optional(),
    warning_count: z.number().nullable().optional(),
  })
  .partial();
export type ImportErrorSummary = z.infer<typeof importErrorSummarySchema>;

/** `mapping.source` — where the staged CSV itself is kept, for disputes. */
export const importMappingSchema = z
  .object({
    company_code: z.string().nullable().optional(),
    delimiter: z.string().nullable().optional(),
    columns: z.record(z.string()).nullable().optional(),
    source: z
      .object({
        bucket: z.string().nullable().optional(),
        path: z.string().nullable().optional(),
        file_name: z.string().nullable().optional(),
        sha256: z.string().nullable().optional(),
        byte_size: z.number().nullable().optional(),
      })
      .partial()
      .nullable()
      .optional(),
  })
  .partial();
export type ImportMapping = z.infer<typeof importMappingSchema>;

export function fetchImportBatches(limit = 25, signal?: AbortSignal): Promise<ImportBatch[]> {
  return selectMany(IMPORT_BATCHES_TABLE, importBatchSchema, {
    filters: [eq("import_kind", IMPORT_KIND_EMPLOYEES)],
    order: [{ column: "created_at", ascending: false }],
    limit,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 2. The staged rows (`import_rows`) — the dispute record
// -----------------------------------------------------------------------------

/** `ck_import_rows__status`. */
export const importRowStatuses = ["pending", "valid", "invalid", "imported", "skipped"] as const;
export type ImportRowStatus = (typeof importRowStatuses)[number];

export const importRowSchema = z.object({
  id: dbUuid,
  batch_id: dbUuid,
  row_number: dbInt,
  /** Every cell exactly as read, keyed by the SOURCE header, plus `__csv_line`. */
  raw: z.record(z.string()),
  normalised: z.unknown().nullable(),
  errors: z.unknown().nullable(),
  status: z.string(),
  created_entity_table: z.string().nullable(),
  created_entity_id: dbUuidNullable,
  recorded_at: dbTimestamp,
});
export type ImportRow = z.infer<typeof importRowSchema>;

/** One cell-level issue as the function stores it in `import_rows.errors`. */
export const importRowIssueSchema = z.object({
  column: z.string(),
  field: z.string().nullable(),
  code: z.string(),
  detail: z.string(),
  raw: z.string(),
  severity: z.enum(["error", "warning"]),
});
export type ImportRowIssue = z.infer<typeof importRowIssueSchema>;

export const importRowIssueListSchema = z.array(importRowIssueSchema);

export interface ImportRowFilters {
  readonly batchId: string;
  readonly statuses?: readonly ImportRowStatus[];
}

export function fetchImportRows(
  f: ImportRowFilters,
  limit = 200,
  signal?: AbortSignal,
): Promise<ImportRow[]> {
  const filters: Filter[] = [eq("batch_id", f.batchId)];
  if (f.statuses && f.statuses.length > 0) filters.push(inList("status", f.statuses));
  return selectMany(IMPORT_ROWS_TABLE, importRowSchema, {
    filters,
    order: [{ column: "row_number", ascending: true }],
    limit,
    ...(signal ? { signal } : {}),
  });
}

/** Postgres counts the rows; the grid never counts its own page (DR-29). */
export function countImportRows(
  f: ImportRowFilters,
  signal?: AbortSignal,
): Promise<number> {
  const filters: Filter[] = [eq("batch_id", f.batchId)];
  if (f.statuses && f.statuses.length > 0) filters.push(inList("status", f.statuses));
  return selectCount(IMPORT_ROWS_TABLE, filters, { ...(signal ? { signal } : {}) });
}

// -----------------------------------------------------------------------------
// 3. The edge-function contract
// -----------------------------------------------------------------------------

const issueSchema = z.object({
  column: z.string(),
  field: z.string().nullable(),
  code: z.string(),
  detail: z.string(),
  rawValue: z.string(),
  severity: z.enum(["error", "warning"]),
});
export type ImportIssue = z.infer<typeof issueSchema>;

const reportedRowSchema = z.object({
  rowNumber: z.number(),
  csvLine: z.number(),
  employeeCode: z.string().nullable(),
  issues: z.array(issueSchema),
});
export type ImportReportedRow = z.infer<typeof reportedRowSchema>;

/**
 * The STAGE answer. Every field here is produced by the function; the screen
 * formats it and adds nothing. `nextStep` is the function's own verdict —
 * `'commit'` only when `totals.invalid` is zero (§4.2 step 4).
 */
export const stageReportSchema = z.object({
  mode: z.literal("stage"),
  batchId: z.string(),
  importKind: z.string(),
  company: z.object({ id: z.string(), code: z.string().nullable() }),
  file: z.object({
    name: z.string(),
    sha256: z.string(),
    byteSize: z.number(),
    storagePath: z.string(),
  }),
  columns: z.object({ mapped: z.record(z.string()), count: z.number() }),
  totals: z.object({
    rows: z.number(),
    valid: z.number(),
    invalid: z.number(),
    rowsWithWarnings: z.number(),
  }),
  reconciliation: z.object({
    /** field → how many rows left that cell blank. */
    nullCounts: z.record(z.number()),
    /** field → SHA-256 over the RAW identifier text, recomputable in the sheet. */
    identifierChecksums: z.record(z.string()),
    /** First ten rows' identifier cells, verbatim — the §4.1 spot check. */
    spotCheck: z.array(z.record(z.string())),
  }),
  rejections: z.array(reportedRowSchema),
  rejectionsTruncated: z.boolean(),
  warnings: z.array(reportedRowSchema),
  warningsTruncated: z.boolean(),
  nextStep: z.string(),
  reason: z.string(),
  requestId: z.string(),
});
export type StageReport = z.infer<typeof stageReportSchema>;

const createdRowSchema = z.object({
  rowNumber: z.number(),
  employeeId: z.string(),
  employeeCode: z.string(),
});
export type ImportCreatedRow = z.infer<typeof createdRowSchema>;

/**
 * The COMMIT answer. `partial: true` + `resume.afterRowNumber` is the function
 * hitting its 40-second work budget, not a failure: the same call with `resume`
 * echoed back continues from that row.
 */
export const commitReportSchema = z.object({
  mode: z.literal("commit"),
  batchId: z.string(),
  status: z.string(),
  totals: z.object({
    rows: z.number(),
    importedThisCall: z.number(),
    importedTotal: z.number(),
    alreadyImported: z.number(),
    remaining: z.number(),
  }),
  managersLinked: z.number(),
  created: z.array(createdRowSchema),
  createdTruncated: z.boolean(),
  partial: z.boolean(),
  resume: z.object({ afterRowNumber: z.number() }).nullable(),
  reason: z.string(),
  requestId: z.string(),
});
export type CommitReport = z.infer<typeof commitReportSchema>;

const envelopeSchema = z.object({ ok: z.literal(true), data: z.unknown() });

/**
 * POST a multipart body to an edge function and zod-parse its payload.
 *
 * Deliberately mirrors `invokeEdgeFn` header for header — the ONLY difference is
 * that `fetch` sets the `Content-Type` boundary itself, which is why this cannot
 * be a flag on that helper.
 */
async function postMultipart<S extends z.ZodTypeAny>(
  name: string,
  form: FormData,
  dataSchema: S,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<z.infer<S>> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;

  const res = await fetch(`${env.supabaseUrl}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      apikey: env.supabasePublishableKey,
      Authorization: `Bearer ${token ?? env.supabasePublishableKey}`,
      "Idempotency-Key": idempotencyKey,
      "x-idempotency-key": idempotencyKey,
      "x-application-name": "tamarind-tree-hrms",
    },
    body: form,
    ...(signal ? { signal } : {}),
  });

  if (!res.ok) {
    let problem: z.infer<typeof problemSchema> = { status: res.status, title: res.statusText };
    try {
      const parsed = problemSchema.safeParse(await res.json());
      if (parsed.success) problem = { status: res.status, ...parsed.data };
    } catch {
      // Non-JSON error body — keep the statusText problem.
    }
    throw new TTApiError(name, res.status, problem, idempotencyKey);
  }

  const json: unknown = await res.json();
  const envelope = envelopeSchema.safeParse(json);
  return dataSchema.parse(envelope.success ? envelope.data.data : json);
}

export interface StageInput {
  readonly file: File;
  readonly delimiter: ImportDelimiter;
  /** Omitted → the function uses the default company. */
  readonly companyCode?: string;
}

/**
 * STEP 1 · Stage and validate. Writes `import_batches` + `import_rows` and not
 * one employee row, whatever the file contains.
 */
export function stageEmployeeImport(
  input: StageInput,
  reason: string,
  idempotencyKey?: string,
  signal?: AbortSignal,
): Promise<StageReport> {
  const form = new FormData();
  // `file` is the part name the function looks for; anything else is a 422.
  form.append("file", input.file, input.file.name);
  form.append("reason", reason.trim());
  form.append("delimiter", input.delimiter);
  if (input.companyCode !== undefined && input.companyCode !== "") {
    form.append("companyCode", input.companyCode);
  }
  return postMultipart(
    EMPLOYEE_IMPORT_FN,
    form,
    stageReportSchema,
    idempotencyKey ?? newIdempotencyKey(),
    signal,
  );
}

export interface CommitInput {
  readonly batchId: string;
  /** Echo `resume.afterRowNumber` from a `partial: true` answer to continue. */
  readonly afterRowNumber?: number;
}

/**
 * STEP 2 · Commit the staged batch. Refused by the server when the batch still
 * holds a rejection, has already been imported, or no longer re-validates.
 */
export function commitEmployeeImport(
  input: CommitInput,
  reason: string,
  idempotencyKey?: string,
): Promise<CommitReport> {
  return invokeEdgeFn(
    EMPLOYEE_IMPORT_FN,
    {
      mode: "commit",
      batchId: input.batchId,
      reason: reason.trim(),
      ...(input.afterRowNumber !== undefined && input.afterRowNumber > 0
        ? { resume: { afterRowNumber: input.afterRowNumber } }
        : {}),
    },
    commitReportSchema,
    { idempotencyKey: idempotencyKey ?? newIdempotencyKey() },
  );
}

// -----------------------------------------------------------------------------
// 4. The column reference / template
// -----------------------------------------------------------------------------

export type ImportColumnGroup =
  | "identity"
  | "employment"
  | "timeRules"
  | "statutory"
  | "bank"
  | "personal"
  | "address"
  | "emergency";

export interface ImportColumnSpec {
  /** Header to put in the CSV: the function's PRIMARY alias for the field. */
  readonly header: string;
  readonly group: ImportColumnGroup;
  /** The function's `kind` — decides how strictly the cell is read. */
  readonly kind: "text" | "identifier" | "date" | "enum" | "integer" | "boolean" | "ref" | "email";
  /** A column mapping to this field must be present or the batch is refused. */
  readonly required?: boolean;
  /** Fixed-length all-digit identifier — the leading-zero-loss detector. */
  readonly fixedDigits?: number;
  /** Accepted values, exactly as the function spells them. */
  readonly enumValues?: readonly string[];
  /** Resolved against a master table by CODE, not by name. */
  readonly reference?: string;
}

/**
 * Every column `employee-import` knows, in its own declaration order. An
 * unrecognised header is a BATCH-level rejection (`unknown_column`), so this list
 * is also the complete set of headers a file may contain.
 */
export const IMPORT_COLUMNS: readonly ImportColumnSpec[] = [
  // ── Identity ───────────────────────────────────────────────────────────────
  { header: "employee_code", group: "identity", kind: "identifier", required: true },
  { header: "title", group: "identity", kind: "text" },
  { header: "first_name", group: "identity", kind: "text", required: true },
  { header: "middle_name", group: "identity", kind: "text" },
  { header: "last_name", group: "identity", kind: "text", required: true },
  { header: "display_name", group: "identity", kind: "text" },
  { header: "preferred_name", group: "identity", kind: "text" },
  { header: "name_in_local_script", group: "identity", kind: "text" },
  { header: "work_email", group: "identity", kind: "email" },
  { header: "personal_email", group: "identity", kind: "email" },
  { header: "mobile", group: "identity", kind: "identifier", fixedDigits: 10 },
  // ── Personal ───────────────────────────────────────────────────────────────
  { header: "date_of_birth", group: "personal", kind: "date" },
  {
    header: "gender",
    group: "personal",
    kind: "enum",
    enumValues: ["male", "female", "transgender", "prefer_not_to_say"],
  },
  {
    header: "blood_group",
    group: "personal",
    kind: "enum",
    enumValues: ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown"],
  },
  {
    header: "marital_status",
    group: "personal",
    kind: "enum",
    enumValues: ["single", "married", "divorced", "widowed", "separated"],
  },
  { header: "father_or_spouse_name", group: "personal", kind: "text" },
  {
    header: "father_or_spouse_relation",
    group: "personal",
    kind: "enum",
    enumValues: ["father", "spouse"],
  },
  { header: "mother_name", group: "personal", kind: "text" },
  { header: "nationality", group: "personal", kind: "text" },
  { header: "religion", group: "personal", kind: "text" },
  {
    header: "category",
    group: "personal",
    kind: "enum",
    enumValues: ["GEN", "OBC", "SC", "ST", "EWS"],
  },
  {
    header: "food_preference",
    group: "personal",
    kind: "enum",
    enumValues: ["veg", "non_veg", "jain", "eggetarian"],
  },
  { header: "uniform_size", group: "personal", kind: "text" },
  { header: "mode_of_transport", group: "personal", kind: "text" },
  // ── Employment ─────────────────────────────────────────────────────────────
  {
    header: "employment_type",
    group: "employment",
    kind: "enum",
    enumValues: [
      "permanent",
      "probation",
      "contract",
      "intern",
      "consultant",
      "casual",
      "apprentice",
      "retainer",
    ],
  },
  {
    header: "employment_status",
    group: "employment",
    kind: "enum",
    enumValues: [
      "pre_joining",
      "active",
      "on_probation",
      "confirmed",
      "on_notice",
      "suspended",
      "on_long_leave",
    ],
  },
  { header: "date_of_join", group: "employment", kind: "date" },
  { header: "probation_months", group: "employment", kind: "integer" },
  { header: "notice_period_days", group: "employment", kind: "integer" },
  { header: "department_code", group: "employment", kind: "ref", reference: "departments" },
  { header: "section_code", group: "employment", kind: "ref", reference: "sections" },
  { header: "designation_code", group: "employment", kind: "ref", reference: "designations" },
  { header: "grade_code", group: "employment", kind: "ref", reference: "grades" },
  { header: "location_code", group: "employment", kind: "ref", reference: "locations" },
  { header: "cost_centre_code", group: "employment", kind: "ref", reference: "cost_centres" },
  { header: "reporting_manager_code", group: "employment", kind: "ref", reference: "employees" },
  // ── Time rules ─────────────────────────────────────────────────────────────
  { header: "shift_code", group: "timeRules", kind: "ref", reference: "shifts" },
  {
    header: "attendance_policy_code",
    group: "timeRules",
    kind: "ref",
    reference: "attendance_policies",
  },
  { header: "weekly_off_rule_code", group: "timeRules", kind: "ref", reference: "weekly_off_rules" },
  {
    header: "holiday_calendar_code",
    group: "timeRules",
    kind: "ref",
    reference: "holiday_calendars",
  },
  { header: "is_ot_eligible", group: "timeRules", kind: "boolean" },
  { header: "is_shift_worker", group: "timeRules", kind: "boolean" },
  {
    header: "punch_mode",
    group: "timeRules",
    kind: "enum",
    enumValues: ["single_punch", "multi_punch"],
  },
  // ── Statutory ──────────────────────────────────────────────────────────────
  {
    header: "payment_mode",
    group: "statutory",
    kind: "enum",
    enumValues: ["bank_transfer", "cash", "cheque", "upi"],
  },
  { header: "pf_number", group: "statutory", kind: "identifier" },
  { header: "uan", group: "statutory", kind: "identifier", fixedDigits: 12 },
  { header: "esi_number", group: "statutory", kind: "identifier", fixedDigits: 17 },
  { header: "pan", group: "statutory", kind: "identifier" },
  { header: "aadhaar_number", group: "statutory", kind: "identifier", fixedDigits: 12 },
  { header: "pf_applicable", group: "statutory", kind: "boolean" },
  { header: "esi_applicable", group: "statutory", kind: "boolean" },
  { header: "tax_regime", group: "statutory", kind: "enum", enumValues: ["old", "new"] },
  // ── Bank ───────────────────────────────────────────────────────────────────
  { header: "bank_beneficiary_name", group: "bank", kind: "text" },
  { header: "bank_name", group: "bank", kind: "text" },
  { header: "bank_branch", group: "bank", kind: "text" },
  { header: "ifsc_code", group: "bank", kind: "identifier" },
  { header: "bank_account_number", group: "bank", kind: "identifier" },
  {
    header: "bank_account_type",
    group: "bank",
    kind: "enum",
    enumValues: ["savings", "current", "salary"],
  },
  // ── Address ────────────────────────────────────────────────────────────────
  { header: "address_line1", group: "address", kind: "text" },
  { header: "address_line2", group: "address", kind: "text" },
  { header: "address_city", group: "address", kind: "text" },
  { header: "address_district", group: "address", kind: "text" },
  { header: "address_state", group: "address", kind: "text" },
  { header: "address_pincode", group: "address", kind: "identifier", fixedDigits: 6 },
  // ── Emergency contact ──────────────────────────────────────────────────────
  { header: "emergency_contact_name", group: "emergency", kind: "text" },
  { header: "emergency_contact_relationship", group: "emergency", kind: "text" },
  { header: "emergency_contact_phone", group: "emergency", kind: "identifier" },
];

/** The three columns without which the function refuses the whole batch. */
export const REQUIRED_IMPORT_HEADERS: readonly string[] = IMPORT_COLUMNS.filter(
  (column) => column.required === true,
).map((column) => column.header);

/**
 * The blank template: ONE fully-quoted header line, nothing else.
 *
 * This is not an export. It carries no row from the database — an export is a PII
 * egress event that only a server function may perform, because only a server
 * function can write the `export_log` row beside it (§14). A header line has
 * nothing to log. Every header is quoted so a spreadsheet opens the file with the
 * columns already text-shaped, which is the whole point of the template.
 */
export function templateCsv(): string {
  return `${IMPORT_COLUMNS.map((column) => `"${column.header}"`).join(",")}\r\n`;
}

export const TEMPLATE_FILE_NAME = "TT_Employee_Import_Template_v1.csv";

/** Bytes → a short human size, for the "6 MB ceiling" line on the upload card. */
export function fileSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
