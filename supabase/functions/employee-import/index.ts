/**
 * employee-import — catalogue #16, auth model **U+** (`employee.import`, which
 * `public.role_capabilities` marks `requires_step_up`).
 *
 * The `1.0202E+11` defence (spec-roadmap §4.1), implemented end to end:
 *
 *   POST multipart/form-data  →  STAGE : parse the client's fully-quoted CSV as
 *                                TEXT, validate every cell, write
 *                                `import_batches` + one `import_rows` row per CSV
 *                                line with the EXACT source text in `raw`, and
 *                                answer with a reconciliation report.
 *   POST application/json     →  COMMIT: re-validate the staged batch, then insert
 *                                `employees` + satellites. Chunked and resumable.
 *
 * THE FIVE RULES THAT ARE NOT NEGOTIABLE (§4.1):
 *   1. `.xlsx` is never a wire format. This endpoint accepts CSV only; the
 *      workbook→CSV conversion happens where the cached FORMATTED string is still
 *      available, i.e. in the spreadsheet, not here.
 *   2. Every identifier is text, forever. Nothing in this file parses an
 *      identifier as a number — there is no `Number()` call on any identifier
 *      path, deliberately, because that is the bug we are defending against.
 *   3. The importer REJECTS, it never coerces. `1.0202E+11`, a pincode that lost
 *      its leading zero, a padded identifier, a Unicode look-alike and an Excel
 *      date serial are all row rejections that quote the raw cell back.
 *   4. Staging first. Nothing reaches `public.employees` until a human has read
 *      the rejection list and called `mode: "commit"` on a batch with ZERO
 *      rejections (§4.2 step 4: "cleanup loop until zero rejections").
 *   5. The raw source cell text survives for dispute resolution
 *      (`import_rows.raw`, JSONB, one object per line keyed by the source header).
 *
 * ONE VALIDATOR, RUN TWICE. `validateRows()` is the only thing in this file that
 * decides whether a row is acceptable, and COMMIT runs it again against the
 * stored `raw` cells before inserting. A batch that validated last Tuesday but
 * whose department code has since been retired fails at commit rather than
 * inserting a row with a dangling reference — and the two answers can never
 * drift, because there is only one function.
 *
 * TWO DELIBERATE, DOCUMENTED SOFTENINGS of "reject everything odd", both of which
 * keep identifiers absolutely untouched:
 *   - Padded whitespace and look-alike characters in FREE-TEXT columns (names,
 *     address lines, remarks) are recorded as `severity: "warning"` on the row and
 *     the trimmed value is used; `raw` still holds the original. In every strict
 *     column (identifier, date, enum, integer, boolean, reference, email) they are
 *     hard rejections.
 *   - `bank_beneficiary_name`, when absent while other bank columns are present,
 *     defaults to the employee's own display name (a derivation from data in the
 *     same row, never a numeric guess) and is reported as a warning.
 *
 * DB GAP (reported, not invented): there is no `employees.import_batch_id` column
 * — spec-roadmap §4.2 step 6 and §8 name one, and `import_batches.raw_payload`
 * too. The linkage is therefore carried by (a) `import_rows.created_entity_table`
 * / `created_entity_id`, (b) an explicit hash-chained audit row per created
 * employee whose `new_value` names the batch id and CSV line. Both are queryable;
 * neither needs a migration this function is not allowed to write.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import {
  badGateway,
  conflict,
  isProblem,
  methodNotAllowed,
  notFound,
  ok,
  problem,
  type ProblemErrorItem,
  toProblem,
  unprocessable,
} from "../_shared/errors.ts";
import { common, parse, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { addDays, isIsoDate, istToday } from "../_shared/datetime.ts";
import {
  clientIpFrom,
  firstRow,
  type RequestContext,
  requestIdFrom,
  serviceClient,
  sql,
  userAgentFrom,
  withContext,
} from "../_shared/db.ts";
import type { Sql } from "../_shared/deps.ts";
import { requireCapWithStepUp, sha256Hex, verifyUser } from "../_shared/auth.ts";
import { enforce, limitKey, RATE_LIMITS } from "../_shared/ratelimit.ts";
import {
  claim,
  release,
  replayResponse,
  requestHash,
  requireIdempotencyKey,
  store,
} from "../_shared/idempotency.ts";
import { writeAudit } from "../_shared/audit.ts";

const FN_NAME = "employee-import";
const CAP = "employee.import";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/** `import_batches.import_kind` — this function owns exactly one kind. */
const IMPORT_KIND = "employees";
/** Uploads land here; bucket + admin-only policy from migration 039. */
const IMPORTS_BUCKET = "imports";

/** A 5,000-row venue roster is ~600 KB of CSV; 6 MB is generous head-room. */
const MAX_FILE_BYTES = 6 * 1024 * 1024;
const MAX_ROWS = 5_000;
const MAX_COLUMNS = 120;
const MAX_CELL_CHARS = 500;
/** Rows inserted per transaction during commit — the unit of resumption. */
const COMMIT_CHUNK_ROWS = 200;
/** Wall clock for the work loop; the rest of the invocation builds the response. */
const WORK_DEADLINE_MS = 40_000;
/** Rejections / creations echoed in one response before truncation. */
const MAX_REPORTED = 200;
/** Rows quoted back for the §4.1 "10-employee spot check". */
const SPOT_CHECK_ROWS = 10;
/** Excel's serial-date origin under the 1900 system (with its leap-year bug). */
const EXCEL_EPOCH = "1899-12-30";

// ═════════════════════════════════════════════════════════════════════════════
// Request contracts
// ═════════════════════════════════════════════════════════════════════════════

/** Multipart form fields (the file itself is handled separately). */
const StageFields = z
  .object({
    reason: common.reason,
    /** Which company the roster belongs to. Omitted = the default company. */
    companyCode: z.string().trim().min(1).max(32).optional(),
    /** `,` or `;` or `\t`. Anything else is a conversion mistake worth surfacing. */
    delimiter: z.enum([",", ";", "\t"]).default(","),
  })
  .strict();

const CommitBody = z
  .object({
    mode: z.literal("commit"),
    batchId: common.uuid,
    reason: common.reason,
    /** Echo `resume` from a `partial: true` response to continue. */
    resume: z.object({ afterRowNumber: z.number().int().min(0) }).strict().optional(),
  })
  .strict();

// ═════════════════════════════════════════════════════════════════════════════
// CSV — RFC 4180, string-safe, no numeric parsing anywhere
// ═════════════════════════════════════════════════════════════════════════════

interface CsvRow {
  /** 1-based index among DATA rows (the header is not a data row). */
  rowNumber: number;
  /** 1-based physical line in the file, for "go and look at line 41". */
  csvLine: number;
  cells: string[];
}

interface ParsedCsv {
  header: string[];
  headerLine: number;
  rows: CsvRow[];
}

/**
 * Parse RFC 4180 CSV with no interpretation of any kind: every field comes back
 * as the exact characters between the delimiters (quotes unwrapped, `""`
 * un-escaped). Leading/trailing whitespace is PRESERVED — detecting it is one of
 * the rejection rules, so stripping it here would destroy the evidence.
 */
function parseCsv(text: string, delimiter: string): ParsedCsv {
  const records: { cells: string[]; line: number }[] = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let recordStartLine = 1;
  let sawAnyChar = false;

  const endField = (): void => {
    cells.push(field);
    field = "";
  };
  const endRecord = (): void => {
    endField();
    records.push({ cells, line: recordStartLine });
    cells = [];
    recordStartLine = line;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      sawAnyChar = true;
      continue;
    }
    if (ch === delimiter) {
      endField();
      sawAnyChar = true;
      continue;
    }
    if (ch === "\r") {
      // Swallow CR of a CRLF pair; a lone CR is also a record terminator.
      if (text[i + 1] === "\n") i += 1;
      line += 1;
      endRecord();
      sawAnyChar = false;
      continue;
    }
    if (ch === "\n") {
      line += 1;
      endRecord();
      sawAnyChar = false;
      continue;
    }
    field += ch;
    sawAnyChar = true;
  }
  if (sawAnyChar || field !== "" || cells.length > 0) endRecord();

  // Drop trailing blank records (a file ending in a newline, or blank lines).
  while (records.length > 0) {
    const last = records[records.length - 1] as { cells: string[]; line: number };
    if (last.cells.every((c) => c.trim() === "")) records.pop();
    else break;
  }

  const headerRecord = records.shift();
  const header = headerRecord?.cells ?? [];
  let rowNumber = 0;
  const rows: CsvRow[] = [];
  for (const record of records) {
    // A blank line inside the file is skipped, not rejected: spreadsheets emit
    // them and they carry no data to dispute.
    if (record.cells.every((c) => c.trim() === "")) continue;
    rowNumber += 1;
    rows.push({ rowNumber, csvLine: record.line, cells: record.cells });
  }
  return { header, headerLine: headerRecord?.line ?? 1, rows };
}

// ═════════════════════════════════════════════════════════════════════════════
// Column catalogue
// ═════════════════════════════════════════════════════════════════════════════

type Kind =
  | "text"
  | "identifier"
  | "date"
  | "enum"
  | "integer"
  | "boolean"
  | "ref"
  | "email";

type RefKind =
  | "department"
  | "section"
  | "designation"
  | "grade"
  | "location"
  | "cost_centre"
  | "shift"
  | "attendance_policy"
  | "weekly_off_rule"
  | "holiday_calendar"
  | "manager";

interface ColumnSpec {
  /**
   * Canonical field name: the key in `import_rows.normalised`, the name in every
   * rejection message, and the name `insertEmployee` reads. The DB column each
   * field lands in is decided in `insertEmployee` and nowhere else — a second
   * mapping here would be a second truth.
   */
  field: string;
  kind: Kind;
  /** Normalised header spellings that map here. */
  aliases: readonly string[];
  required?: boolean;
  /** Mirrors the table's CHECK constraint exactly. */
  pattern?: RegExp;
  patternHint?: string;
  /** Fixed-length all-digit identifier — the leading-zero-loss detector. */
  fixedDigits?: number;
  enumValues?: readonly string[];
  ref?: RefKind;
  maxChars?: number;
  /** Uppercase the value before validating (PAN, IFSC, codes). */
  upper?: boolean;
}

/** Strict columns tolerate no padding and no non-ASCII whatsoever. */
function isStrict(spec: ColumnSpec): boolean {
  return spec.kind !== "text";
}

const EMPLOYMENT_TYPES = [
  "permanent",
  "probation",
  "contract",
  "intern",
  "consultant",
  "casual",
  "apprentice",
  "retainer",
] as const;

const EMPLOYMENT_STATUSES = [
  "pre_joining",
  "active",
  "on_probation",
  "confirmed",
  "on_notice",
  "suspended",
  "on_long_leave",
] as const;

const COLUMNS: readonly ColumnSpec[] = [
  // ── Identity ───────────────────────────────────────────────────────────────
  {
    field: "employee_code",
    kind: "identifier",
    aliases: ["employee_code", "emp_code", "employee_id", "emp_id", "code", "staff_code"],
    required: true,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$/,
    patternHint: "letters, digits and . _ / - only, up to 32 characters",
    maxChars: 32,
  },
  { field: "title", kind: "text", aliases: ["title", "salutation"], maxChars: 20 },
  {
    field: "first_name",
    kind: "text",
    aliases: ["first_name", "firstname", "given_name"],
    required: true,
    maxChars: 100,
  },
  {
    field: "middle_name",
    kind: "text",
    aliases: ["middle_name", "middlename"],
    maxChars: 100,
  },
  {
    field: "last_name",
    kind: "text",
    aliases: ["last_name", "lastname", "surname", "family_name"],
    required: true,
    maxChars: 100,
  },
  {
    field: "display_name",
    kind: "text",
    aliases: ["display_name", "full_name", "name", "employee_name"],
    maxChars: 150,
  },
  {
    field: "preferred_name",
    kind: "text",
    aliases: ["preferred_name", "nick_name", "called_as"],
    maxChars: 100,
  },
  {
    field: "name_in_local_script",
    kind: "text",
    aliases: ["name_in_local_script", "name_kannada", "kannada_name"],
    maxChars: 150,
  },
  // ── Contact ────────────────────────────────────────────────────────────────
  {
    field: "work_email",
    kind: "email",
    aliases: ["work_email", "official_email", "company_email"],
  },
  {
    field: "personal_email",
    kind: "email",
    aliases: ["personal_email", "email", "email_id", "private_email"],
  },
  {
    field: "mobile",
    kind: "identifier",
    aliases: ["mobile", "mobile_number", "phone", "phone_number", "contact_number", "cell"],
    pattern: /^[6-9][0-9]{9}$/,
    patternHint: "a 10-digit Indian mobile starting 6-9",
    fixedDigits: 10,
  },
  // ── Personal ───────────────────────────────────────────────────────────────
  {
    field: "date_of_birth",
    kind: "date",
    aliases: ["date_of_birth", "dob", "birth_date", "date_dt"],
  },
  {
    field: "gender",
    kind: "enum",
    aliases: ["gender", "sex"],
    enumValues: ["male", "female", "transgender", "prefer_not_to_say"],
  },
  {
    field: "blood_group",
    kind: "enum",
    aliases: ["blood_group", "blood"],
    enumValues: ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown"],
    upper: true,
  },
  {
    field: "marital_status",
    kind: "enum",
    aliases: ["marital_status", "marital"],
    enumValues: ["single", "married", "divorced", "widowed", "separated"],
  },
  {
    field: "father_or_spouse_name",
    kind: "text",
    aliases: ["father_or_spouse_name", "father_name", "spouse_name", "father_s_name"],
    maxChars: 150,
  },
  {
    field: "father_or_spouse_relation",
    kind: "enum",
    aliases: ["father_or_spouse_relation", "relation_of_guardian"],
    enumValues: ["father", "spouse"],
  },
  {
    field: "mother_name",
    kind: "text",
    aliases: ["mother_name", "mother_s_name"],
    maxChars: 150,
  },
  {
    field: "nationality",
    kind: "text",
    aliases: ["nationality"],
    maxChars: 60,
  },
  { field: "religion", kind: "text", aliases: ["religion"], maxChars: 60 },
  {
    field: "category",
    kind: "enum",
    aliases: ["category", "caste_category", "social_category"],
    enumValues: ["GEN", "OBC", "SC", "ST", "EWS"],
    upper: true,
  },
  {
    field: "food_preference",
    kind: "enum",
    aliases: ["food_preference", "food"],
    enumValues: ["veg", "non_veg", "jain", "eggetarian"],
  },
  {
    field: "uniform_size",
    kind: "text",
    aliases: ["uniform_size", "uniform"],
    maxChars: 20,
  },
  {
    field: "mode_of_transport",
    kind: "text",
    aliases: ["mode_of_transport", "transport"],
    maxChars: 60,
  },
  // ── Employment ─────────────────────────────────────────────────────────────
  {
    field: "employment_type",
    kind: "enum",
    aliases: ["employment_type", "emp_type", "employee_type"],
    enumValues: EMPLOYMENT_TYPES,
  },
  {
    field: "employment_status",
    kind: "enum",
    aliases: ["employment_status", "status", "emp_status"],
    enumValues: EMPLOYMENT_STATUSES,
  },
  {
    field: "date_of_join",
    kind: "date",
    aliases: ["date_of_join", "doj", "joining_date", "date_of_joining", "join_date"],
  },
  {
    field: "probation_months",
    kind: "integer",
    aliases: ["probation_months", "probation"],
  },
  {
    field: "notice_period_days",
    kind: "integer",
    aliases: ["notice_period_days", "notice_period", "notice_days"],
  },
  {
    field: "department_code",
    kind: "ref",
    aliases: ["department_code", "department", "dept", "dept_code"],
    ref: "department",
    upper: true,
  },
  {
    field: "section_code",
    kind: "ref",
    aliases: ["section_code", "section", "sub_department"],
    ref: "section",
    upper: true,
  },
  {
    field: "designation_code",
    kind: "ref",
    aliases: ["designation_code", "designation", "role", "job_title"],
    ref: "designation",
    upper: true,
  },
  {
    field: "grade_code",
    kind: "ref",
    aliases: ["grade_code", "grade", "band"],
    ref: "grade",
    upper: true,
  },
  {
    field: "location_code",
    kind: "ref",
    aliases: ["location_code", "location", "site", "branch"],
    ref: "location",
    upper: true,
  },
  {
    field: "cost_centre_code",
    kind: "ref",
    aliases: ["cost_centre_code", "cost_centre", "cost_center", "cc"],
    ref: "cost_centre",
    upper: true,
  },
  {
    field: "reporting_manager_code",
    kind: "ref",
    aliases: ["reporting_manager_code", "reports_to", "manager_code", "manager", "reporting_manager"],
    ref: "manager",
    upper: true,
  },
  {
    field: "shift_code",
    kind: "ref",
    aliases: ["shift_code", "shift", "default_shift"],
    ref: "shift",
    upper: true,
  },
  {
    field: "attendance_policy_code",
    kind: "ref",
    aliases: ["attendance_policy_code", "attendance_policy"],
    ref: "attendance_policy",
    upper: true,
  },
  {
    field: "weekly_off_rule_code",
    kind: "ref",
    aliases: ["weekly_off_rule_code", "weekly_off", "weekly_off_pattern"],
    ref: "weekly_off_rule",
    upper: true,
  },
  {
    field: "holiday_calendar_code",
    kind: "ref",
    aliases: ["holiday_calendar_code", "holiday_calendar"],
    ref: "holiday_calendar",
    upper: true,
  },
  {
    field: "is_ot_eligible",
    kind: "boolean",
    aliases: ["is_ot_eligible", "ot_eligible", "overtime_eligible"],
  },
  {
    field: "is_shift_worker",
    kind: "boolean",
    aliases: ["is_shift_worker", "shift_worker"],
  },
  {
    field: "punch_mode",
    kind: "enum",
    aliases: ["punch_mode"],
    enumValues: ["single_punch", "multi_punch"],
  },
  {
    field: "payment_mode",
    kind: "enum",
    aliases: ["payment_mode", "salary_payment_mode"],
    enumValues: ["bank_transfer", "cash", "cheque", "upi"],
  },
  // ── Statutory (the columns the E+ defect actually damages) ─────────────────
  {
    field: "pf_number",
    kind: "identifier",
    aliases: ["pf_number", "pf_no", "pf_account_number", "epf_number"],
    pattern: /^[A-Z]{2}\/[A-Z]{3}\/[0-9]{7}\/[0-9]{3}\/[0-9]{7}$|^[A-Z0-9/]{10,30}$/,
    patternHint: "the establishment PF account string, e.g. KN/BNG/1234567/000/0001234",
    upper: true,
  },
  {
    field: "uan",
    kind: "identifier",
    aliases: ["uan", "uan_number", "universal_account_number"],
    pattern: /^[0-9]{12}$/,
    patternHint: "exactly 12 digits",
    fixedDigits: 12,
  },
  {
    field: "esi_number",
    kind: "identifier",
    aliases: ["esi_number", "esi_no", "esic_number", "ip_number"],
    pattern: /^[0-9]{17}$/,
    patternHint: "exactly 17 digits",
    fixedDigits: 17,
  },
  {
    field: "pan",
    kind: "identifier",
    aliases: ["pan", "pan_number", "pan_no", "income_tax_pan"],
    pattern: /^[A-Z]{5}[0-9]{4}[A-Z]$/,
    patternHint: "5 letters, 4 digits, 1 letter",
    upper: true,
  },
  {
    field: "aadhaar_number",
    kind: "identifier",
    aliases: ["aadhaar_number", "aadhaar", "aadhar", "aadhar_number", "uid"],
    pattern: /^[2-9][0-9]{11}$/,
    patternHint: "12 digits starting 2-9, with a valid Verhoeff check digit",
    fixedDigits: 12,
  },
  {
    field: "pf_applicable",
    kind: "boolean",
    aliases: ["pf_applicable", "pf_eligible"],
  },
  {
    field: "esi_applicable",
    kind: "boolean",
    aliases: ["esi_applicable", "esi_eligible"],
  },
  {
    field: "tax_regime",
    kind: "enum",
    aliases: ["tax_regime", "regime"],
    enumValues: ["old", "new"],
  },
  // ── Bank ───────────────────────────────────────────────────────────────────
  {
    field: "bank_beneficiary_name",
    kind: "text",
    aliases: ["bank_beneficiary_name", "beneficiary_name", "account_holder_name", "account_name"],
    maxChars: 150,
  },
  {
    field: "bank_name",
    kind: "text",
    aliases: ["bank_name", "bank"],
    maxChars: 120,
  },
  {
    field: "bank_branch",
    kind: "text",
    aliases: ["bank_branch", "branch", "branch_name"],
    maxChars: 120,
  },
  {
    field: "ifsc_code",
    kind: "identifier",
    aliases: ["ifsc_code", "ifsc", "ifs_code"],
    pattern: /^[A-Z]{4}0[A-Z0-9]{6}$/,
    patternHint: "4 letters, a zero, then 6 letters/digits",
    upper: true,
  },
  {
    field: "bank_account_number",
    kind: "identifier",
    aliases: ["bank_account_number", "account_number", "account_no", "a_c_no", "bank_a_c_no"],
    pattern: /^[0-9]{6,20}$/,
    patternHint: "6 to 20 digits",
  },
  {
    field: "bank_account_type",
    kind: "enum",
    aliases: ["bank_account_type", "account_type"],
    enumValues: ["savings", "current", "salary"],
  },
  // ── Permanent address ──────────────────────────────────────────────────────
  {
    field: "address_line1",
    kind: "text",
    aliases: ["address_line1", "address_1", "address", "permanent_address", "address_line_1"],
    maxChars: 200,
  },
  {
    field: "address_line2",
    kind: "text",
    aliases: ["address_line2", "address_2", "address_line_2"],
    maxChars: 200,
  },
  {
    field: "address_city",
    kind: "text",
    aliases: ["address_city", "city", "town"],
    maxChars: 100,
  },
  {
    field: "address_district",
    kind: "text",
    aliases: ["address_district", "district"],
    maxChars: 100,
  },
  {
    field: "address_state",
    kind: "text",
    aliases: ["address_state", "state"],
    maxChars: 100,
  },
  {
    field: "address_pincode",
    kind: "identifier",
    aliases: ["address_pincode", "pincode", "pin_code", "postal_code", "zip"],
    pattern: /^[1-9][0-9]{5}$/,
    patternHint: "6 digits, not starting with 0",
    fixedDigits: 6,
  },
  // ── Emergency contact ──────────────────────────────────────────────────────
  {
    field: "emergency_contact_name",
    kind: "text",
    aliases: ["emergency_contact_name", "emergency_contact", "emergency_name"],
    maxChars: 150,
  },
  {
    field: "emergency_contact_relationship",
    kind: "text",
    aliases: ["emergency_contact_relationship", "emergency_relation", "emergency_relationship"],
    maxChars: 60,
  },
  {
    field: "emergency_contact_phone",
    kind: "identifier",
    aliases: ["emergency_contact_phone", "emergency_contact_number", "emergency_phone", "emergency_number"],
    pattern: /^[0-9]{6,14}$/,
    patternHint: "6 to 14 digits, no spaces or punctuation",
  },
];

const SPEC_BY_ALIAS: ReadonlyMap<string, ColumnSpec> = (() => {
  const map = new Map<string, ColumnSpec>();
  for (const spec of COLUMNS) {
    for (const alias of spec.aliases) map.set(alias, spec);
    map.set(spec.field, spec);
  }
  return map;
})();

/** Columns whose per-column checksum belongs in the reconciliation report (§4.1). */
const CHECKSUM_FIELDS: readonly string[] = [
  "employee_code",
  "mobile",
  "pan",
  "aadhaar_number",
  "uan",
  "esi_number",
  "pf_number",
  "ifsc_code",
  "bank_account_number",
  "address_pincode",
];

/** `"Employee Code "` → `employee_code`; `"Date_Dt"` → `date_dt`. */
function normaliseHeader(raw: string): string {
  return raw
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ═════════════════════════════════════════════════════════════════════════════
// Cell inspection — the §4.1 rejection rules
// ═════════════════════════════════════════════════════════════════════════════

type Severity = "error" | "warning";

interface CellIssue {
  column: string;
  field: string | null;
  code: string;
  detail: string;
  /** The source text, quoted back verbatim. This is the dispute record. */
  raw: string;
  severity: Severity;
}

/** Scientific notation — the `1.0202E+11` signature itself. */
const E_NOTATION_RE = /^[+-]?\d+(?:[.,]\d+)?\s*[eE]\s*[+-]?\d+$/;
/** Spreadsheet error literals that must never be read as data. */
const SPREADSHEET_ERROR_RE = /^#(?:REF|VALUE|NAME\?|DIV\/0|N\/A|NULL|NUM)!?$/i;
/** A column too narrow to render its own number. */
const COLUMN_OVERFLOW_RE = /^#{3,}$/;
/**
 * Characters that look like ASCII but are not — written as escapes on purpose so
 * that reading this file tells you exactly what is banned, and so a stray
 * copy-paste can never quietly damage the rule: NBSP and the Unicode space
 * family, zero-widths and BOM, Unicode dashes, curly quotes and minus,
 * full-width and Devanagari digits, and the Cyrillic / Greek homoglyphs that turn
 * one person's PAN into another person's PAN.
 */
const CONFUSABLE_RE = new RegExp(
  "[" +
    "\\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000" +
    "\\u200B-\\u200D\\u2060\\uFEFF" +
    "\\u2010-\\u2015\\u2018\\u2019\\u201C\\u201D\\u2212" +
    "\\uFF10-\\uFF19\\uFF21-\\uFF3A\\uFF41-\\uFF5A" +
    "\\u0966-\\u096F" +
    "\\u0400-\\u04FF\\u0370-\\u03FF" +
    "]",
);

const VERHOEFF_D: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

const VERHOEFF_P: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** SHA-256 of the uploaded bytes — the file's identity in the batch record. */
async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  // The copy into a fresh `ArrayBuffer` is deliberate, and matches
  // `document-generate`: a `Uint8Array` may be backed by a `SharedArrayBuffer`,
  // which is not a `BufferSource`, so pinning the type here keeps this compiling
  // on every TypeScript version rather than only the one that widened
  // `Uint8Array` to a generic.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Verhoeff check over a 12-digit Aadhaar — the exact algorithm and tables of
 * `util.is_valid_aadhaar` (migration 002), so the edge and the CHECK constraint
 * agree to the digit. Digit-by-digit on the STRING; the number is never parsed.
 */
function aadhaarChecksumValid(value: string): boolean {
  let check = 0;
  for (let i = 0; i < value.length; i++) {
    const digit = value.charCodeAt(value.length - 1 - i) - 48;
    if (digit < 0 || digit > 9) return false;
    const permuted = VERHOEFF_P[i % 8]?.[digit];
    const next = permuted === undefined ? undefined : VERHOEFF_D[check]?.[permuted];
    if (next === undefined) return false;
    check = next;
  }
  return check === 0;
}

/** `45123` → `2023-07-11`, so the rejection can say what the number probably was. */
function excelSerialHint(value: string): string | null {
  if (!/^\d{4,6}$/.test(value)) return null;
  let serial = 0;
  for (const ch of value) serial = serial * 10 + (ch.charCodeAt(0) - 48);
  if (serial < 1 || serial > 80_000) return null;
  return addDays(EXCEL_EPOCH, serial);
}

const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

/**
 * Accept only unambiguous written dates: `YYYY-MM-DD`, `DD-MM-YYYY`,
 * `DD/MM/YYYY` and `DD-MMM-YYYY`. A bare number is an Excel serial and is
 * rejected by the caller; `03/04/2026` is treated as DD/MM (Indian convention,
 * and the same convention the source pack asks for), which is why a two-digit
 * year is refused outright rather than guessed.
 */
function parseWrittenDate(value: string): { iso: string } | { error: string } {
  const v = value.trim();
  let iso: string | null = null;

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (isoMatch !== null) iso = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  if (iso === null) {
    const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(v);
    if (dmy !== null) {
      const day = (dmy[1] as string).padStart(2, "0");
      const month = (dmy[2] as string).padStart(2, "0");
      iso = `${dmy[3]}-${month}-${day}`;
    }
  }

  if (iso === null) {
    const dMonY = /^(\d{1,2})[-/ ]([A-Za-z]{3,9})[-/ ](\d{4})$/.exec(v);
    if (dMonY !== null) {
      const month = MONTHS[(dMonY[2] as string).slice(0, 3).toLowerCase()];
      if (month === undefined) return { error: "the month name is not recognised" };
      iso = `${dMonY[3]}-${month}-${(dMonY[1] as string).padStart(2, "0")}`;
    }
  }

  if (iso === null) {
    if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{2}$/.test(v)) {
      return { error: "two-digit years are ambiguous; write the full four-digit year" };
    }
    return { error: "expected YYYY-MM-DD, DD-MM-YYYY or DD-MMM-YYYY" };
  }

  // `isIsoDate` is the calendar check: `2026-02-31` fails it rather than sliding
  // silently into March, which is how a wrong date of birth gets stored.
  if (!isIsoDate(iso)) return { error: "that calendar date does not exist" };
  return { iso };
}

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "t"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "f"]);

interface CellResult {
  /** The value to store in `normalised`. `null` means "not supplied". */
  value: string | boolean | number | null;
  issues: CellIssue[];
}

/**
 * The whole §4.1 rule set for one cell, in the order that makes the FIRST
 * message the most useful one: structural damage (E+, spreadsheet errors,
 * look-alikes, padding) before format, format before semantics.
 */
function inspectCell(header: string, spec: ColumnSpec, raw: string): CellResult {
  const issues: CellIssue[] = [];
  const push = (code: string, detail: string, severity: Severity = "error"): void => {
    issues.push({ column: header, field: spec.field, code, detail, raw, severity });
  };

  if (raw.length > MAX_CELL_CHARS) {
    push("CELL_TOO_LONG", `The cell holds ${raw.length} characters; the ceiling is ${MAX_CELL_CHARS}.`);
    return { value: null, issues };
  }

  const strict = isStrict(spec);
  const trimmed = raw.trim();

  // 1. Absent. Emptiness is not an error here; `required` is checked per row.
  if (trimmed === "") return { value: null, issues };

  // 2. Spreadsheet damage. These are never data, in any column.
  if (E_NOTATION_RE.test(trimmed)) {
    push(
      "SOURCE_PRECISION_LOST",
      `The cell is scientific notation (${JSON.stringify(raw)}), so the source workbook has ` +
        "already destroyed digits. Go back to the source document and re-export this column " +
        "as text — this value cannot be guessed.",
    );
    return { value: null, issues };
  }
  if (SPREADSHEET_ERROR_RE.test(trimmed)) {
    push("SOURCE_FORMULA_ERROR", `The cell holds the spreadsheet error ${JSON.stringify(raw)}.`);
    return { value: null, issues };
  }
  if (COLUMN_OVERFLOW_RE.test(trimmed)) {
    push(
      "SOURCE_COLUMN_OVERFLOW",
      `The cell holds ${JSON.stringify(raw)} — the column was too narrow to render its value, ` +
        "so the exported text is not the value.",
    );
    return { value: null, issues };
  }

  // 3. Padding. A padded identifier is a rejection; a padded name is a warning.
  if (raw !== trimmed) {
    if (strict) {
      push(
        "PADDED_WHITESPACE",
        `The cell is padded with whitespace (${JSON.stringify(raw)}). An identifier is stored ` +
          "exactly as given, so the padding must be removed at the source.",
      );
      return { value: null, issues };
    }
    push("PADDED_WHITESPACE", `Whitespace trimmed from ${JSON.stringify(raw)}.`, "warning");
  }

  // 4. Look-alikes.
  if (CONFUSABLE_RE.test(trimmed)) {
    const codes = [...trimmed]
      .filter((ch) => CONFUSABLE_RE.test(ch))
      .map((ch) => `U+${ch.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`)
      .join(", ");
    if (strict) {
      push(
        "UNICODE_LOOKALIKE",
        `The cell contains characters that only look like ASCII (${codes}). Retype the value ` +
          "in the source rather than letting it be stored as a different string.",
      );
      return { value: null, issues };
    }
    push("UNICODE_LOOKALIKE", `Non-ASCII look-alike characters present (${codes}).`, "warning");
  }

  const cased = spec.upper === true ? trimmed.toUpperCase() : trimmed;

  // 5. Per-kind rules.
  switch (spec.kind) {
    case "text": {
      if (spec.maxChars !== undefined && cased.length > spec.maxChars) {
        push("TOO_LONG", `At most ${spec.maxChars} characters.`);
        return { value: null, issues };
      }
      return { value: cased, issues };
    }

    case "identifier": {
      if (/\s/.test(cased)) {
        push("INTERNAL_WHITESPACE", "An identifier may not contain spaces — remove them at the source.");
        return { value: null, issues };
      }
      if (spec.fixedDigits !== undefined && /^\d+$/.test(cased) && cased.length < spec.fixedDigits) {
        push(
          "LEADING_ZERO_LOSS",
          `${JSON.stringify(raw)} is ${cased.length} digits where ${spec.fixedDigits} are required. ` +
            "A spreadsheet stored this as a number and dropped the leading zero(s); the original " +
            "value must come from the source document.",
        );
        return { value: null, issues };
      }
      if (spec.pattern !== undefined && !spec.pattern.test(cased)) {
        const hint = spec.patternHint === undefined ? "" : ` Expected ${spec.patternHint}.`;
        push("INVALID_FORMAT", `${JSON.stringify(raw)} is not a valid ${spec.field}.${hint}`);
        return { value: null, issues };
      }
      if (spec.field === "aadhaar_number" && !aadhaarChecksumValid(cased)) {
        push(
          "AADHAAR_CHECKSUM_FAILED",
          `${JSON.stringify(raw)} fails the Verhoeff check digit, so at least one digit is wrong.`,
        );
        return { value: null, issues };
      }
      return { value: cased, issues };
    }

    case "email": {
      if (!/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(cased) || cased.length > 254) {
        push("INVALID_FORMAT", `${JSON.stringify(raw)} is not a valid email address.`);
        return { value: null, issues };
      }
      return { value: cased.toLowerCase(), issues };
    }

    case "date": {
      const serialHint = excelSerialHint(cased);
      if (serialHint !== null) {
        push(
          "EXCEL_DATE_SERIAL",
          `${JSON.stringify(raw)} is an Excel date serial (it would mean ${serialHint}). ` +
            "Format the column as text with a written date before exporting — the importer will " +
            "not guess a date from a number.",
        );
        return { value: null, issues };
      }
      const parsed = parseWrittenDate(cased);
      if ("error" in parsed) {
        push("INVALID_DATE", `${JSON.stringify(raw)}: ${parsed.error}.`);
        return { value: null, issues };
      }
      if (parsed.iso >= "2100-01-01") {
        push(
          "SENTINEL_DATE",
          `${JSON.stringify(raw)} is a sentinel date. Open-ended values are left blank, ` +
            "never written as a year-3000 placeholder.",
        );
        return { value: null, issues };
      }
      return { value: parsed.iso, issues };
    }

    case "enum": {
      const candidate = spec.upper === true ? cased : cased.toLowerCase().replace(/[\s-]+/g, "_");
      const allowed = spec.enumValues ?? [];
      if (!allowed.includes(candidate)) {
        push("INVALID_VALUE", `${JSON.stringify(raw)} is not one of: ${allowed.join(", ")}.`);
        return { value: null, issues };
      }
      return { value: candidate, issues };
    }

    case "integer": {
      if (!/^\d{1,4}$/.test(cased)) {
        push("INVALID_NUMBER", `${JSON.stringify(raw)} is not a whole number.`);
        return { value: null, issues };
      }
      // A count, not an identifier: this is the one place a numeric read is safe.
      return { value: Number.parseInt(cased, 10), issues };
    }

    case "boolean": {
      const word = cased.toLowerCase();
      if (TRUE_WORDS.has(word)) return { value: true, issues };
      if (FALSE_WORDS.has(word)) return { value: false, issues };
      push("INVALID_BOOLEAN", `${JSON.stringify(raw)} is not yes/no.`);
      return { value: null, issues };
    }

    case "ref": {
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$/.test(cased)) {
        push("INVALID_FORMAT", `${JSON.stringify(raw)} is not a valid ${spec.field}.`);
        return { value: null, issues };
      }
      return { value: cased, issues };
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Reference data
// ═════════════════════════════════════════════════════════════════════════════

interface SectionRef {
  id: string;
  departmentId: string | null;
}

interface RefData {
  companyId: string;
  companyCode: string;
  departments: Map<string, string>;
  sections: Map<string, SectionRef>;
  designations: Map<string, string>;
  grades: Map<string, string>;
  locations: Map<string, string>;
  costCentres: Map<string, string>;
  shifts: Map<string, string>;
  attendancePolicies: Map<string, string>;
  weeklyOffRules: Map<string, string>;
  holidayCalendars: Map<string, string>;
  /** Existing employees, by UPPER(employee_code) — duplicate and manager lookup. */
  employeesByCode: Map<string, string>;
  /** Existing work emails, lowercased. */
  workEmails: Set<string>;
}

function codeMap(value: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string") map.set(k.toUpperCase(), v);
    }
  }
  return map;
}

/** One round-trip for every code table the file can reference. */
async function loadRefData(
  tx: Sql,
  companyCode: string | null,
  codes: readonly string[],
  emails: readonly string[],
): Promise<RefData> {
  const companyRows = await tx`
    SELECT c.id, c.code
      FROM public.companies c
     WHERE c.deleted_at IS NULL
       AND (${companyCode}::text IS NULL OR upper(c.code) = upper(${companyCode}::text))
     ORDER BY (c.is_default IS TRUE) DESC, c.code
     LIMIT 2
  `;
  const companies = companyRows as unknown as { id: string; code: string }[];
  if (companies.length === 0) {
    throw notFound(
      companyCode === null
        ? "No company is set up yet, so employees cannot be imported."
        : `No company has the code ${companyCode}.`,
      "COMPANY_NOT_FOUND",
    );
  }
  if (companyCode === null && companies.length > 1) {
    throw unprocessable(
      [{
        pointer: "/companyCode",
        code: "ambiguous",
        detail: "More than one company exists and none is marked default; name the company code.",
      }],
      "The target company is ambiguous.",
      "COMPANY_AMBIGUOUS",
    );
  }
  const company = companies[0] as { id: string; code: string };

  const bundleRows = await tx`
    SELECT jsonb_build_object(
             'departments', (SELECT COALESCE(jsonb_object_agg(upper(d.code), d.id), '{}'::jsonb)
                               FROM public.departments d
                              WHERE d.company_id = ${company.id}::uuid AND d.deleted_at IS NULL),
             'sections', (SELECT COALESCE(jsonb_object_agg(upper(s.code),
                                   jsonb_build_object('id', s.id, 'department_id', s.department_id)), '{}'::jsonb)
                            FROM public.sections s
                            JOIN public.departments d2 ON d2.id = s.department_id
                           WHERE d2.company_id = ${company.id}::uuid
                             AND s.deleted_at IS NULL AND d2.deleted_at IS NULL),
             'designations', (SELECT COALESCE(jsonb_object_agg(upper(x.code), x.id), '{}'::jsonb)
                                FROM public.designations x
                               WHERE x.company_id = ${company.id}::uuid AND x.deleted_at IS NULL),
             'grades', (SELECT COALESCE(jsonb_object_agg(upper(x.code), x.id), '{}'::jsonb)
                          FROM public.grades x
                         WHERE x.company_id = ${company.id}::uuid AND x.deleted_at IS NULL),
             'locations', (SELECT COALESCE(jsonb_object_agg(upper(x.code), x.id), '{}'::jsonb)
                             FROM public.locations x
                            WHERE x.company_id = ${company.id}::uuid AND x.deleted_at IS NULL),
             'cost_centres', (SELECT COALESCE(jsonb_object_agg(upper(x.code), x.id), '{}'::jsonb)
                                FROM public.cost_centres x
                               WHERE x.company_id = ${company.id}::uuid AND x.deleted_at IS NULL),
             'shifts', (SELECT COALESCE(jsonb_object_agg(upper(x.code), x.id), '{}'::jsonb)
                          FROM public.shifts x
                         WHERE x.company_id = ${company.id}::uuid AND x.deleted_at IS NULL AND x.is_active),
             'attendance_policies', (SELECT COALESCE(jsonb_object_agg(upper(x.code), x.id), '{}'::jsonb)
                                       FROM public.attendance_policies x
                                      WHERE x.company_id = ${company.id}::uuid AND x.deleted_at IS NULL),
             'weekly_off_rules', (SELECT COALESCE(jsonb_object_agg(upper(x.code), x.id), '{}'::jsonb)
                                    FROM public.weekly_off_rules x
                                   WHERE x.company_id = ${company.id}::uuid),
             'holiday_calendars', (SELECT COALESCE(jsonb_object_agg(upper(x.code), x.id), '{}'::jsonb)
                                     FROM public.holiday_calendars x
                                    WHERE x.company_id = ${company.id}::uuid AND x.deleted_at IS NULL)
           ) AS bundle
  `;
  const bundle = ((bundleRows as unknown as { bundle: Record<string, unknown> }[])[0]?.bundle ??
    {}) as Record<string, unknown>;

  const sections = new Map<string, SectionRef>();
  const rawSections = bundle.sections;
  if (rawSections !== null && typeof rawSections === "object") {
    for (const [code, value] of Object.entries(rawSections as Record<string, unknown>)) {
      const entry = (value ?? {}) as Record<string, unknown>;
      if (typeof entry.id === "string") {
        sections.set(code.toUpperCase(), {
          id: entry.id,
          departmentId: typeof entry.department_id === "string" ? entry.department_id : null,
        });
      }
    }
  }

  const existing = await tx`
    SELECT e.id,
           upper(e.employee_code) AS code,
           lower(e.work_email)    AS work_email
      FROM public.employees e
     WHERE e.deleted_at IS NULL
       AND (upper(e.employee_code) = ANY(${[...codes]}::text[])
            OR lower(e.work_email) = ANY(${[...emails]}::text[]))
  `;
  const employeesByCode = new Map<string, string>();
  const workEmails = new Set<string>();
  for (const row of existing as unknown as { id: string; code: string; work_email: string | null }[]) {
    employeesByCode.set(row.code, row.id);
    if (row.work_email !== null && row.work_email !== "") workEmails.add(row.work_email);
  }

  return {
    companyId: company.id,
    companyCode: company.code,
    departments: codeMap(bundle.departments),
    sections,
    designations: codeMap(bundle.designations),
    grades: codeMap(bundle.grades),
    locations: codeMap(bundle.locations),
    costCentres: codeMap(bundle.cost_centres),
    shifts: codeMap(bundle.shifts),
    attendancePolicies: codeMap(bundle.attendance_policies),
    weeklyOffRules: codeMap(bundle.weekly_off_rules),
    holidayCalendars: codeMap(bundle.holiday_calendars),
    employeesByCode,
    workEmails,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Row validation
// ═════════════════════════════════════════════════════════════════════════════

interface HeaderMapping {
  /** Source header text, in file order. */
  headers: string[];
  /** Index → spec, for the columns that mapped. */
  specByIndex: Map<number, ColumnSpec>;
  /** Source header → canonical field, for the response. */
  mapped: Record<string, string>;
}

/**
 * Map the header row. An unrecognised column is a BATCH-level rejection, not a
 * silent drop: a column nobody mapped is either a typo in the header or a field
 * we were supposed to import, and guessing between those is exactly what §4.1
 * forbids.
 */
function mapHeader(header: readonly string[]): { mapping: HeaderMapping; errors: ProblemErrorItem[] } {
  const errors: ProblemErrorItem[] = [];
  const specByIndex = new Map<number, ColumnSpec>();
  const mapped: Record<string, string> = {};
  const seen = new Map<string, number>();
  const headers = [...header];

  if (headers.length > MAX_COLUMNS) {
    errors.push({
      pointer: "/file",
      code: "too_many_columns",
      detail: `The file has ${headers.length} columns; the ceiling is ${MAX_COLUMNS}.`,
    });
  }

  headers.forEach((raw, index) => {
    const key = normaliseHeader(raw);
    if (key === "") {
      errors.push({
        pointer: `/file/header/${index}`,
        code: "blank_header",
        detail: `Column ${index + 1} has no header. Name it or delete it.`,
      });
      return;
    }
    const spec = SPEC_BY_ALIAS.get(key);
    if (spec === undefined) {
      errors.push({
        pointer: `/file/header/${index}`,
        code: "unknown_column",
        detail: `Column ${JSON.stringify(raw)} is not a field this importer knows. Rename it to a ` +
          "supported field or remove it — it will not be silently ignored.",
      });
      return;
    }
    const previous = seen.get(spec.field);
    if (previous !== undefined) {
      errors.push({
        pointer: `/file/header/${index}`,
        code: "duplicate_column",
        detail: `Columns ${previous + 1} and ${index + 1} both map to ${spec.field}.`,
      });
      return;
    }
    seen.set(spec.field, index);
    specByIndex.set(index, spec);
    mapped[raw] = spec.field;
  });

  for (const spec of COLUMNS) {
    if (spec.required === true && !seen.has(spec.field)) {
      errors.push({
        pointer: "/file/header",
        code: "missing_column",
        detail: `A column mapping to ${spec.field} is required.`,
      });
    }
  }

  return { mapping: { headers, specByIndex, mapped }, errors };
}

type NormalisedRow = Record<string, string | boolean | number | null>;

interface ValidatedRow {
  rowNumber: number;
  csvLine: number;
  /** Exact source cells, keyed by source header. Written to `import_rows.raw`. */
  raw: Record<string, string>;
  normalised: NormalisedRow;
  issues: CellIssue[];
  valid: boolean;
  employeeCode: string | null;
}

function str(row: NormalisedRow, field: string): string | null {
  const value = row[field];
  return typeof value === "string" && value !== "" ? value : null;
}

function bool(row: NormalisedRow, field: string): boolean | null {
  const value = row[field];
  return typeof value === "boolean" ? value : null;
}

function int(row: NormalisedRow, field: string): number | null {
  const value = row[field];
  return typeof value === "number" ? value : null;
}

/**
 * Validate every row of a batch: cells, then cross-field rules, then the
 * uniqueness rules that need the whole file and the database at once.
 */
function validateRows(
  rows: readonly { rowNumber: number; csvLine: number; raw: Record<string, string> }[],
  mapping: HeaderMapping,
  refs: RefData,
): ValidatedRow[] {
  const today = istToday();
  const earliest = addDays(today, -365 * 60);
  const seenCodes = new Map<string, number>();
  const seenEmails = new Map<string, number>();
  const out: ValidatedRow[] = [];

  // Every employee code the FILE declares, gathered before validation begins: a
  // manager may legitimately appear on a line BELOW their reportee, so
  // "is this manager code in the file" cannot be answered from rows seen so far.
  const codeHeaderIndex = [...mapping.specByIndex]
    .find(([, spec]) => spec.field === "employee_code")?.[0];
  const codesInFile = new Set<string>();
  if (codeHeaderIndex !== undefined) {
    const header = mapping.headers[codeHeaderIndex] as string;
    for (const row of rows) {
      const value = (row.raw[header] ?? "").trim().toUpperCase();
      if (value !== "") codesInFile.add(value);
    }
  }

  for (const row of rows) {
    const issues: CellIssue[] = [];
    const normalised: NormalisedRow = {};

    for (const [index, spec] of mapping.specByIndex) {
      const header = mapping.headers[index] as string;
      const cell = row.raw[header] ?? "";
      const result = inspectCell(header, spec, cell);
      issues.push(...result.issues);
      normalised[spec.field] = result.value;
    }

    const add = (
      field: string | null,
      code: string,
      detail: string,
      raw = "",
      severity: Severity = "error",
    ): void => {
      issues.push({ column: field ?? "", field, code, detail, raw, severity });
    };

    // ── Required ────────────────────────────────────────────────────────────
    for (const spec of COLUMNS) {
      if (spec.required !== true) continue;
      if (normalised[spec.field] === null || normalised[spec.field] === undefined) {
        // Do not pile a "required" error on top of a rejection that already
        // explains why the value did not survive.
        const alreadyFlagged = issues.some((i) => i.field === spec.field && i.severity === "error");
        if (!alreadyFlagged) add(spec.field, "REQUIRED_MISSING", `${spec.field} is required.`);
      }
    }

    const code = str(normalised, "employee_code");

    // ── Duplicates: within the file, then against the database ──────────────
    if (code !== null) {
      const upper = code.toUpperCase();
      const first = seenCodes.get(upper);
      if (first !== undefined) {
        add(
          "employee_code",
          "DUPLICATE_IN_FILE",
          `${JSON.stringify(code)} also appears on row ${first}. An employee code is identity and ` +
            "must appear once.",
          code,
        );
      } else {
        seenCodes.set(upper, row.rowNumber);
      }
      if (refs.employeesByCode.has(upper)) {
        add(
          "employee_code",
          "DUPLICATE_IN_DATABASE",
          `An employee with code ${JSON.stringify(code)} already exists. This importer only ` +
            "creates records; correct the existing one instead.",
          code,
        );
      }
    }

    const workEmail = str(normalised, "work_email");
    if (workEmail !== null) {
      const first = seenEmails.get(workEmail);
      if (first !== undefined) {
        add("work_email", "DUPLICATE_IN_FILE", `${workEmail} also appears on row ${first}.`, workEmail);
      } else {
        seenEmails.set(workEmail, row.rowNumber);
      }
      if (refs.workEmails.has(workEmail)) {
        add("work_email", "DUPLICATE_IN_DATABASE", `${workEmail} is already a work email.`, workEmail);
      }
    }

    // ── References ──────────────────────────────────────────────────────────
    const resolveRef = (field: string, kind: RefKind): void => {
      const value = str(normalised, field);
      if (value === null) return;
      const key = value.toUpperCase();
      let id: string | null = null;
      switch (kind) {
        case "department":
          id = refs.departments.get(key) ?? null;
          break;
        case "section":
          id = refs.sections.get(key)?.id ?? null;
          break;
        case "designation":
          id = refs.designations.get(key) ?? null;
          break;
        case "grade":
          id = refs.grades.get(key) ?? null;
          break;
        case "location":
          id = refs.locations.get(key) ?? null;
          break;
        case "cost_centre":
          id = refs.costCentres.get(key) ?? null;
          break;
        case "shift":
          id = refs.shifts.get(key) ?? null;
          break;
        case "attendance_policy":
          id = refs.attendancePolicies.get(key) ?? null;
          break;
        case "weekly_off_rule":
          id = refs.weeklyOffRules.get(key) ?? null;
          break;
        case "holiday_calendar":
          id = refs.holidayCalendars.get(key) ?? null;
          break;
        case "manager":
          // A manager is either an employee that already exists or another line
          // of this same file. The link itself is applied after every row has
          // been inserted (see the deferred pass in the handler), so "present in
          // the file" is a complete answer here.
          id = refs.employeesByCode.get(key) ?? null;
          if (id === null && codesInFile.has(key)) {
            normalised[`${field}__in_file`] = true;
            return;
          }
          break;
      }
      if (id === null) {
        add(
          field,
          "UNRESOLVED_REFERENCE",
          `${JSON.stringify(value)} does not match any ${kind.replace(/_/g, " ")} for company ` +
            `${refs.companyCode}. Seed it first — the importer will not create one.`,
          value,
        );
        return;
      }
      normalised[`${field}__id`] = id;
    };

    resolveRef("department_code", "department");
    resolveRef("section_code", "section");
    resolveRef("designation_code", "designation");
    resolveRef("grade_code", "grade");
    resolveRef("location_code", "location");
    resolveRef("cost_centre_code", "cost_centre");
    resolveRef("shift_code", "shift");
    resolveRef("attendance_policy_code", "attendance_policy");
    resolveRef("weekly_off_rule_code", "weekly_off_rule");
    resolveRef("holiday_calendar_code", "holiday_calendar");
    resolveRef("reporting_manager_code", "manager");

    // A section must belong to the department named on the same row.
    const sectionCode = str(normalised, "section_code");
    const departmentId = str(normalised, "department_code__id");
    if (sectionCode !== null && departmentId !== null) {
      const section = refs.sections.get(sectionCode.toUpperCase());
      if (section !== undefined && section.departmentId !== departmentId) {
        add(
          "section_code",
          "REFERENCE_MISMATCH",
          `Section ${JSON.stringify(sectionCode)} does not belong to the department on this row.`,
          sectionCode,
        );
      }
    }
    if (str(normalised, "reporting_manager_code") !== null && code !== null) {
      const manager = str(normalised, "reporting_manager_code") as string;
      if (manager.toUpperCase() === code.toUpperCase()) {
        add("reporting_manager_code", "SELF_MANAGER", "An employee cannot report to themselves.", manager);
      }
    }

    // ── Dates ───────────────────────────────────────────────────────────────
    const dob = str(normalised, "date_of_birth");
    const doj = str(normalised, "date_of_join");
    if (dob !== null) {
      if (dob > today) add("date_of_birth", "DATE_IN_FUTURE", "A date of birth cannot be in the future.", dob);
      else if (dob > addDays(today, -365 * 14)) {
        add("date_of_birth", "AGE_BELOW_MINIMUM", "The date of birth implies an age under 14.", dob);
      } else if (dob < earliest) add("date_of_birth", "DATE_IMPLAUSIBLE", "That date of birth is implausible.", dob);
    }
    if (doj !== null) {
      if (doj > addDays(today, 365)) {
        add("date_of_join", "DATE_IMPLAUSIBLE", "A joining date more than a year out is refused.", doj);
      }
      if (dob !== null && doj <= addDays(dob, 365 * 14)) {
        add("date_of_join", "DATE_ORDER", "The joining date is not at least 14 years after the birth date.", doj);
      }
    }

    // ── Cross-field guards the CHECK constraints would otherwise raise on ──
    if (
      str(normalised, "father_or_spouse_name") !== null &&
      str(normalised, "father_or_spouse_relation") === null
    ) {
      add(
        "father_or_spouse_relation",
        "REQUIRED_TOGETHER",
        "Say whether the named person is the father or the spouse.",
      );
    }
    const probation = int(normalised, "probation_months");
    if (probation !== null && (probation < 0 || probation > 24)) {
      add("probation_months", "OUT_OF_RANGE", "Probation must be 0–24 months.", String(probation));
    }
    const notice = int(normalised, "notice_period_days");
    if (notice !== null && (notice < 0 || notice > 180)) {
      add("notice_period_days", "OUT_OF_RANGE", "Notice period must be 0–180 days.", String(notice));
    }

    // ── Satellite all-or-nothing groups ─────────────────────────────────────
    const bankFields = ["bank_name", "ifsc_code", "bank_account_number", "bank_beneficiary_name", "bank_branch"];
    const bankPresent = bankFields.some((f) => normalised[f] !== null && normalised[f] !== undefined);
    if (bankPresent) {
      for (const f of ["bank_name", "ifsc_code", "bank_account_number"]) {
        if (str(normalised, f) === null && !issues.some((i) => i.field === f && i.severity === "error")) {
          add(f, "REQUIRED_TOGETHER", `${f} is required once any bank column is filled in.`);
        }
      }
      if (str(normalised, "bank_beneficiary_name") === null) {
        // A derivation from the same row, not a guess at a number.
        const derived = str(normalised, "display_name") ??
          [str(normalised, "first_name"), str(normalised, "last_name")].filter((v) => v !== null).join(" ");
        if (derived !== "") {
          normalised.bank_beneficiary_name = derived;
          add(
            "bank_beneficiary_name",
            "DERIVED_FROM_ROW",
            `Beneficiary name defaulted to ${JSON.stringify(derived)}; verify against the passbook.`,
            "",
            "warning",
          );
        }
      }
    }

    const addressFields = ["address_line1", "address_city", "address_state", "address_pincode"];
    const addressAny = [...addressFields, "address_line2", "address_district"].some(
      (f) => normalised[f] !== null && normalised[f] !== undefined,
    );
    if (addressAny) {
      for (const f of addressFields) {
        if (str(normalised, f) === null && !issues.some((i) => i.field === f && i.severity === "error")) {
          add(f, "REQUIRED_TOGETHER", `${f} is required once any address column is filled in.`);
        }
      }
    }

    const emergencyFields = [
      "emergency_contact_name",
      "emergency_contact_relationship",
      "emergency_contact_phone",
    ];
    const emergencyAny = emergencyFields.some((f) => normalised[f] !== null && normalised[f] !== undefined);
    if (emergencyAny) {
      for (const f of emergencyFields) {
        if (str(normalised, f) === null && !issues.some((i) => i.field === f && i.severity === "error")) {
          add(f, "REQUIRED_TOGETHER", `${f} is required once any emergency-contact column is filled in.`);
        }
      }
    }

    out.push({
      rowNumber: row.rowNumber,
      csvLine: row.csvLine,
      raw: row.raw,
      normalised,
      issues,
      valid: !issues.some((i) => i.severity === "error"),
      employeeCode: code,
    });
  }

  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// Reconciliation report (§4.1: row counts, null counts, identifier checksums)
// ═════════════════════════════════════════════════════════════════════════════

interface Reconciliation {
  rowCount: number;
  validCount: number;
  invalidCount: number;
  warningRowCount: number;
  nullCounts: Record<string, number>;
  identifierChecksums: Record<string, string>;
  spotCheck: Record<string, string>[];
}

async function reconcile(
  mapping: HeaderMapping,
  rows: readonly ValidatedRow[],
): Promise<Reconciliation> {
  const nullCounts: Record<string, number> = {};
  const checksumSource = new Map<string, string[]>();

  for (const [index, spec] of mapping.specByIndex) {
    const header = mapping.headers[index] as string;
    nullCounts[spec.field] = 0;
    if (CHECKSUM_FIELDS.includes(spec.field)) checksumSource.set(spec.field, []);
    for (const row of rows) {
      const cell = row.raw[header] ?? "";
      if (cell.trim() === "") nullCounts[spec.field] = (nullCounts[spec.field] ?? 0) + 1;
      checksumSource.get(spec.field)?.push(`${row.rowNumber}:${cell}`);
    }
  }

  const identifierChecksums: Record<string, string> = {};
  for (const [field, values] of checksumSource) {
    // Over the RAW text, so the client can recompute it from their own sheet.
    identifierChecksums[field] = await sha256Hex(values.join("\n"));
  }

  const spotCheck = rows.slice(0, SPOT_CHECK_ROWS).map((row) => {
    const picked: Record<string, string> = { row_number: String(row.rowNumber) };
    for (const [index, spec] of mapping.specByIndex) {
      if (!CHECKSUM_FIELDS.includes(spec.field)) continue;
      const header = mapping.headers[index] as string;
      picked[spec.field] = row.raw[header] ?? "";
    }
    return picked;
  });

  return {
    rowCount: rows.length,
    validCount: rows.filter((r) => r.valid).length,
    invalidCount: rows.filter((r) => !r.valid).length,
    warningRowCount: rows.filter((r) => r.valid && r.issues.length > 0).length,
    nullCounts,
    identifierChecksums,
    spotCheck,
  };
}

function reportRow(row: ValidatedRow): Record<string, unknown> {
  return {
    rowNumber: row.rowNumber,
    csvLine: row.csvLine,
    employeeCode: row.employeeCode,
    issues: row.issues.map((i) => ({
      column: i.column,
      field: i.field,
      code: i.code,
      detail: i.detail,
      rawValue: i.raw,
      severity: i.severity,
    })),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Insert one employee and its satellites
// ═════════════════════════════════════════════════════════════════════════════

interface InsertOutcome {
  employeeId: string;
  employeeCode: string;
  satellites: string[];
}

/**
 * `employees` + the satellite rows the row carries, inside the caller's
 * transaction and therefore under the same `app.*` context. The field-level
 * audit rows come from `trg_employees__audit` (migration 038) automatically; the
 * batch linkage is written by the caller because no column exists for it.
 */
async function insertEmployee(
  tx: Sql,
  row: ValidatedRow,
  refs: RefData,
  employmentStatusDefault: string,
): Promise<InsertOutcome> {
  const n = row.normalised;
  const today = istToday();
  const doj = str(n, "date_of_join");
  const status = str(n, "employment_status") ??
    (doj === null || doj > today ? "pre_joining" : employmentStatusDefault);
  const firstName = str(n, "first_name") as string;
  const lastName = str(n, "last_name") as string;
  const displayName = str(n, "display_name") ?? `${firstName} ${lastName}`.trim();

  const employeeRows = await tx`
    INSERT INTO public.employees (
      company_id, employee_code, title, first_name, middle_name, last_name,
      display_name, preferred_name, name_in_local_script,
      work_email, personal_email, mobile,
      date_of_birth, gender, blood_group,
      marital_status, father_or_spouse_name, father_or_spouse_relation, mother_name,
      nationality, religion, category, food_preference, uniform_size, mode_of_transport,
      employment_type, employment_status, date_of_join,
      probation_months, notice_period_days,
      department_id, section_id, designation_id, grade_id, location_id, cost_centre_id,
      shift_id, attendance_policy_id, weekly_off_rule_id, holiday_calendar_id,
      is_ot_eligible, is_shift_worker, punch_mode, payment_mode
    ) VALUES (
      ${refs.companyId}::uuid,
      ${str(n, "employee_code")}::text,
      ${str(n, "title")}::text,
      ${firstName}::text,
      ${str(n, "middle_name")}::text,
      ${lastName}::text,
      ${displayName}::text,
      ${str(n, "preferred_name")}::text,
      ${str(n, "name_in_local_script")}::text,
      ${str(n, "work_email")}::text,
      ${str(n, "personal_email")}::text,
      ${str(n, "mobile")}::text,
      ${str(n, "date_of_birth")}::date,
      ${str(n, "gender")}::public.gender,
      COALESCE(${str(n, "blood_group")}::public.blood_group, 'unknown'::public.blood_group),
      ${str(n, "marital_status")}::public.marital_status,
      ${str(n, "father_or_spouse_name")}::text,
      ${str(n, "father_or_spouse_relation")}::text,
      ${str(n, "mother_name")}::text,
      COALESCE(${str(n, "nationality")}::text, 'Indian'),
      ${str(n, "religion")}::text,
      ${str(n, "category")}::text,
      ${str(n, "food_preference")}::text,
      ${str(n, "uniform_size")}::text,
      ${str(n, "mode_of_transport")}::text,
      COALESCE(${str(n, "employment_type")}::public.employment_type, 'probation'::public.employment_type),
      ${status}::public.employment_status,
      ${doj}::date,
      COALESCE(${int(n, "probation_months")}::integer, 6),
      COALESCE(${int(n, "notice_period_days")}::integer, 30),
      ${str(n, "department_code__id")}::uuid,
      ${str(n, "section_code__id")}::uuid,
      ${str(n, "designation_code__id")}::uuid,
      ${str(n, "grade_code__id")}::uuid,
      ${str(n, "location_code__id")}::uuid,
      ${str(n, "cost_centre_code__id")}::uuid,
      ${str(n, "shift_code__id")}::uuid,
      ${str(n, "attendance_policy_code__id")}::uuid,
      ${str(n, "weekly_off_rule_code__id")}::uuid,
      ${str(n, "holiday_calendar_code__id")}::uuid,
      COALESCE(${bool(n, "is_ot_eligible")}::boolean, true),
      COALESCE(${bool(n, "is_shift_worker")}::boolean, true),
      COALESCE(${str(n, "punch_mode")}::public.punch_mode, 'multi_punch'::public.punch_mode),
      COALESCE(${str(n, "payment_mode")}::public.payment_mode, 'bank_transfer'::public.payment_mode)
    )
    RETURNING id, employee_code
  `;
  const created = firstRow(employeeRows as unknown as { id: string; employee_code: string }[]);
  if (created === null) {
    throw problem(500, "Internal server error", "The employee row was not created.", undefined, {
      code: "INSERT_RETURNED_NOTHING",
    });
  }
  const employeeId = created.id;
  const satellites: string[] = [];

  // ── employee_statutory (PK employee_id, at most one row) ──────────────────
  const statutoryFields = ["pf_number", "uan", "esi_number", "pan", "aadhaar_number"];
  const hasStatutory = statutoryFields.some((f) => str(n, f) !== null) ||
    bool(n, "pf_applicable") !== null || bool(n, "esi_applicable") !== null ||
    str(n, "tax_regime") !== null;
  if (hasStatutory) {
    await tx`
      INSERT INTO public.employee_statutory (
        employee_id, pf_applicable, pf_number, uan, esi_applicable, esi_number,
        pan, aadhaar_number, tax_regime
      ) VALUES (
        ${employeeId}::uuid,
        COALESCE(${bool(n, "pf_applicable")}::boolean, ${str(n, "uan") !== null || str(n, "pf_number") !== null}::boolean),
        ${str(n, "pf_number")}::text,
        ${str(n, "uan")}::text,
        COALESCE(${bool(n, "esi_applicable")}::boolean, ${str(n, "esi_number") !== null}::boolean),
        ${str(n, "esi_number")}::text,
        ${str(n, "pan")}::text,
        ${str(n, "aadhaar_number")}::text,
        COALESCE(${str(n, "tax_regime")}::text, 'new')
      )
    `;
    satellites.push("public.employee_statutory");
  }

  // ── employee_bank_accounts + the employees pointer to it ──────────────────
  if (str(n, "bank_account_number") !== null && str(n, "ifsc_code") !== null) {
    const bankRows = await tx`
      INSERT INTO public.employee_bank_accounts (
        employee_id, beneficiary_name, bank_name, branch, ifsc, account_number,
        account_type, is_verified, is_active, effective_from
      ) VALUES (
        ${employeeId}::uuid,
        ${str(n, "bank_beneficiary_name") ?? displayName}::text,
        ${str(n, "bank_name")}::text,
        ${str(n, "bank_branch")}::text,
        ${str(n, "ifsc_code")}::text,
        ${str(n, "bank_account_number")}::text,
        COALESCE(${str(n, "bank_account_type")}::text, 'savings'),
        false,
        true,
        COALESCE(${doj}::date, CURRENT_DATE)
      )
      RETURNING id
    `;
    const bankId = firstRow(bankRows as unknown as { id: string }[])?.id ?? null;
    if (bankId !== null) {
      await tx`
        UPDATE public.employees
           SET primary_bank_account_id = ${bankId}::uuid
         WHERE id = ${employeeId}::uuid
      `;
      satellites.push("public.employee_bank_accounts");
    }
  }

  // ── employee_addresses (permanent) ───────────────────────────────────────
  if (str(n, "address_line1") !== null && str(n, "address_pincode") !== null) {
    await tx`
      INSERT INTO public.employee_addresses (
        employee_id, address_kind, line1, line2, city, district, state, pincode, is_current
      ) VALUES (
        ${employeeId}::uuid,
        'permanent',
        ${str(n, "address_line1")}::text,
        ${str(n, "address_line2")}::text,
        ${str(n, "address_city")}::text,
        ${str(n, "address_district")}::text,
        ${str(n, "address_state")}::text,
        ${str(n, "address_pincode")}::text,
        true
      )
    `;
    satellites.push("public.employee_addresses");
  }

  // ── employee_contacts: own mobile + emergency contact ────────────────────
  const mobile = str(n, "mobile");
  if (mobile !== null) {
    await tx`
      INSERT INTO public.employee_contacts (employee_id, contact_kind, value, is_primary)
      VALUES (${employeeId}::uuid, 'mobile', ${mobile}::text, true)
    `;
    satellites.push("public.employee_contacts");
  }
  const emergencyPhone = str(n, "emergency_contact_phone");
  if (emergencyPhone !== null) {
    await tx`
      INSERT INTO public.employee_contacts
        (employee_id, contact_kind, value, contact_name, relationship, is_primary)
      VALUES (
        ${employeeId}::uuid,
        'emergency',
        ${emergencyPhone}::text,
        ${str(n, "emergency_contact_name")}::text,
        ${str(n, "emergency_contact_relationship")}::text,
        true
      )
    `;
    if (!satellites.includes("public.employee_contacts")) satellites.push("public.employee_contacts");
  }

  return { employeeId, employeeCode: created.employee_code, satellites };
}

// ═════════════════════════════════════════════════════════════════════════════
// Handler
// ═════════════════════════════════════════════════════════════════════════════

Deno.serve(async (req: Request): Promise<Response> => {
  // ── STEP 1 · OPTIONS / CORS ────────────────────────────────────────────────
  const preflight = handlePreflight(req, ALLOWED_METHODS);
  if (preflight !== null) return preflight;
  const cors = corsHeaders(req);

  // ── STEP 2 · Method allowlist ──────────────────────────────────────────────
  if (req.method !== "POST") return methodNotAllowed(ALLOWED_METHODS).toResponse(cors);

  // ── STEP 3 · request_id + timer ────────────────────────────────────────────
  const requestId = requestIdFrom(req);
  const log = createLogger({ fn: FN_NAME, requestId });
  const instance = new URL(req.url).pathname;

  let status = 500;
  let idempotencyKey: string | null = null;
  /** Set once the source CSV is in the bucket, so a failure can undo it. */
  let uploaded: { bucket: string; path: string } | null = null;

  try {
    assertOriginAllowed(req);

    // ── STEP 4 · Auth (model U+) ────────────────────────────────────────────
    const auth = await verifyUser(req);
    const db = sql();

    // ── STEP 5 · Authority, from the DATABASE ───────────────────────────────
    // `employee.import` carries `requires_step_up` in `role_capabilities`, which
    // is what makes this function U+ without a second hard-coded list.
    await requireCapWithStepUp(db, auth, CAP);

    // ── STEP 6 · Rate limit ─────────────────────────────────────────────────
    await enforce(RATE_LIMITS.heavyJob, limitKey(FN_NAME, auth.userId), "IMPORT_RATE_LIMITED");

    // ── STEP 7 · Validate ───────────────────────────────────────────────────
    const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
    const isMultipart = contentType.includes("multipart/form-data");
    const declaredLength = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_FILE_BYTES + 64 * 1024) {
      throw problem(413, "Payload too large", `The upload exceeds ${MAX_FILE_BYTES} bytes.`, undefined, {
        code: "PAYLOAD_TOO_LARGE",
      });
    }

    let mode: "stage" | "commit";
    let fields: z.infer<typeof StageFields> | null = null;
    let commit: z.infer<typeof CommitBody> | null = null;
    let fileBytes: Uint8Array | null = null;
    let fileName = "";
    let fileSha = "";

    if (isMultipart) {
      mode = "stage";
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        throw unprocessable(
          [{ pointer: "/file", code: "required", detail: "Attach the CSV as the `file` part." }],
          "No CSV was attached.",
          "FILE_REQUIRED",
        );
      }
      if (file.size > MAX_FILE_BYTES) {
        throw problem(413, "Payload too large", `The CSV exceeds ${MAX_FILE_BYTES} bytes.`, undefined, {
          code: "PAYLOAD_TOO_LARGE",
        });
      }
      fileName = file.name === "" ? "employees.csv" : file.name.slice(0, 200);
      if (/\.(xlsx|xls|xlsm|numbers|ods)$/i.test(fileName)) {
        throw unprocessable(
          [{
            pointer: "/file",
            code: "unsupported_format",
            detail: "A workbook is never accepted as a wire format: its cells have already been " +
              "parsed as numbers. Export a fully-quoted CSV of the FORMATTED values and upload that.",
          }],
          "Upload a CSV, not a spreadsheet.",
          "WORKBOOK_NOT_ACCEPTED",
        );
      }
      fileBytes = new Uint8Array(await file.arrayBuffer());
      const rawFields: Record<string, unknown> = {};
      for (const [key, value] of form.entries()) {
        if (key === "file") continue;
        if (typeof value === "string") rawFields[key] = value;
      }
      fields = parse(StageFields, rawFields, "form fields");
      fileSha = await sha256HexBytes(fileBytes);
    } else {
      const raw = await req.text();
      if (raw.trim() === "") {
        throw unprocessable(
          [{ pointer: "", code: "required", detail: "Send a JSON body or a multipart CSV upload." }],
          "The request body is empty.",
          "BODY_REQUIRED",
        );
      }
      if (!contentType.includes("application/json")) {
        throw problem(415, "Unsupported media type", "Send multipart/form-data or application/json.", undefined, {
          code: "UNSUPPORTED_MEDIA_TYPE",
        });
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch {
        throw unprocessable(
          [{ pointer: "", code: "invalid_json", detail: "Body is not valid JSON." }],
          "The request body could not be parsed as JSON.",
          "MALFORMED_JSON",
        );
      }
      commit = parse(CommitBody, decoded);
      mode = "commit";
      fileSha = await sha256Hex(raw);
    }

    const reason = (fields?.reason ?? commit?.reason) as string;

    // ── STEP 8 · Idempotency claim ──────────────────────────────────────────
    // Both branches mutate, so both must carry a key: a retried stage would
    // create a second batch, a retried commit a second set of employees.
    idempotencyKey = requireIdempotencyKey(req);
    const canonical = [
      mode,
      commit?.batchId ?? "",
      commit?.resume?.afterRowNumber ?? "",
      fileName,
      fileSha,
      fields?.companyCode ?? "",
      fields?.delimiter ?? "",
    ].join("\n");
    const claimed = await claim({
      key: idempotencyKey,
      fnName: FN_NAME,
      requestHash: await requestHash(FN_NAME, canonical, auth.userId),
      actorId: auth.userId,
    });
    if (claimed.state === "replay") {
      status = claimed.status;
      log.info("idempotent replay", { key: idempotencyKey });
      return replayResponse(claimed, { ...cors, "x-request-id": requestId });
    }

    // ── STEP 9 · Request context (used by every transaction below) ──────────
    const ctx: RequestContext = {
      actorId: auth.userId,
      actorRole: auth.role,
      // `public.actor_source` has a dedicated value for exactly this path.
      source: "import",
      sourceRoute: FN_NAME,
      requestId,
      ip: clientIpFrom(req),
      ua: userAgentFrom(req),
      reason,
    };

    // ═══════════════════════════════════════════════════════════════════════
    // STAGE
    // ═══════════════════════════════════════════════════════════════════════
    if (mode === "stage") {
      const bytes = fileBytes as Uint8Array;
      const stageFields = fields as z.infer<typeof StageFields>;

      // Strict UTF-8: a Latin-1 or UTF-16 export is a conversion mistake, and it
      // is precisely where look-alike bytes hide. Refuse rather than mojibake.
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw unprocessable(
          [{
            pointer: "/file",
            code: "encoding",
            detail: "The file is not valid UTF-8. Re-export it as 'CSV UTF-8' so no character is " +
              "silently substituted.",
          }],
          "The CSV encoding is not UTF-8.",
          "ENCODING_INVALID",
        );
      }
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

      const parsed = parseCsv(text, stageFields.delimiter);
      if (parsed.header.length === 0 || parsed.rows.length === 0) {
        throw unprocessable(
          [{ pointer: "/file", code: "empty", detail: "The CSV has a header but no data rows." }],
          "There is nothing to import.",
          "FILE_EMPTY",
        );
      }
      if (parsed.rows.length > MAX_ROWS) {
        throw unprocessable(
          [{
            pointer: "/file",
            code: "too_many_rows",
            detail: `${parsed.rows.length} rows exceeds the ${MAX_ROWS}-row ceiling for one batch. ` +
              "Split the file.",
          }],
          "The file is too large for one batch.",
          "TOO_MANY_ROWS",
        );
      }

      const { mapping, errors: headerErrors } = mapHeader(parsed.header);
      if (headerErrors.length > 0) {
        throw unprocessable(
          headerErrors.slice(0, 50),
          `The header row was rejected (${headerErrors.length} problem${headerErrors.length === 1 ? "" : "s"}). ` +
            "Nothing was staged.",
          "HEADER_REJECTED",
        );
      }

      // Ragged rows are a structural defect: a shifted row would map values into
      // the wrong columns, which is how a PAN becomes a bank account.
      const ragged = parsed.rows.filter((r) => r.cells.length !== mapping.headers.length);
      if (ragged.length > 0) {
        throw unprocessable(
          ragged.slice(0, 20).map((r) => ({
            pointer: `/file/row/${r.rowNumber}`,
            code: "column_count_mismatch",
            detail: `CSV line ${r.csvLine} has ${r.cells.length} fields; the header has ` +
              `${mapping.headers.length}. An unescaped quote or comma is the usual cause.`,
          })),
          `${ragged.length} row(s) do not have the same number of fields as the header. Nothing was staged.`,
          "ROW_SHAPE_MISMATCH",
        );
      }

      const rawRows = parsed.rows.map((row) => {
        const raw: Record<string, string> = {};
        mapping.headers.forEach((header, index) => {
          raw[header] = row.cells[index] ?? "";
        });
        return { rowNumber: row.rowNumber, csvLine: row.csvLine, raw };
      });

      // Reference data is read inside a context transaction because the code
      // tables' RLS helpers read `app.actor_id`; service_role bypasses RLS, but
      // the context also stamps anything the read touches.
      const codes = new Set<string>();
      const emails = new Set<string>();
      const codeIndex = [...mapping.specByIndex].find(([, s]) => s.field === "employee_code")?.[0];
      const emailIndex = [...mapping.specByIndex].find(([, s]) => s.field === "work_email")?.[0];
      const managerIndex = [...mapping.specByIndex].find(([, s]) => s.field === "reporting_manager_code")?.[0];
      for (const row of parsed.rows) {
        if (codeIndex !== undefined) codes.add((row.cells[codeIndex] ?? "").trim().toUpperCase());
        if (managerIndex !== undefined) codes.add((row.cells[managerIndex] ?? "").trim().toUpperCase());
        if (emailIndex !== undefined) emails.add((row.cells[emailIndex] ?? "").trim().toLowerCase());
      }

      const refs = await withContext(ctx, (tx) =>
        loadRefData(tx, stageFields.companyCode ?? null, [...codes], [...emails]));

      const validated = validateRows(rawRows, mapping, refs);
      const reconciliation = await reconcile(mapping, validated);

      // ── Upload the source CSV FIRST (Storage is not transactional) ────────
      const batchId = crypto.randomUUID();
      const objectPath = `${refs.companyId}/${IMPORT_KIND}/${batchId}-${fileName.replace(/[^A-Za-z0-9._-]+/g, "_")}`;
      const upload = await serviceClient().storage.from(IMPORTS_BUCKET).upload(objectPath, bytes, {
        contentType: "text/csv; charset=utf-8",
        upsert: false,
        cacheControl: "no-store",
      });
      if (upload.error !== null) {
        log.error("import upload failed", { bucket: IMPORTS_BUCKET, err: upload.error });
        throw badGateway("The source file could not be stored, so nothing was staged.", "STORAGE_UPLOAD_FAILED", {
          cause: upload.error,
        });
      }
      uploaded = { bucket: IMPORTS_BUCKET, path: objectPath };

      // `mapping` carries everything COMMIT needs to read the batch the same way
      // STAGE did, plus the pointer to the source object for dispute resolution.
      const batchMapping = JSON.stringify({
        company_id: refs.companyId,
        company_code: refs.companyCode,
        delimiter: stageFields.delimiter,
        columns: mapping.mapped,
        source: {
          bucket: IMPORTS_BUCKET,
          path: objectPath,
          file_name: fileName,
          sha256: fileSha,
          byte_size: bytes.byteLength,
        },
        reconciliation: {
          null_counts: reconciliation.nullCounts,
          identifier_checksums: reconciliation.identifierChecksums,
        },
      });
      const errorSummary = JSON.stringify({
        by_code: validated
          .flatMap((row) => row.issues.filter((issue) => issue.severity === "error"))
          .reduce<Record<string, number>>((acc, issue) => {
            acc[issue.code] = (acc[issue.code] ?? 0) + 1;
            return acc;
          }, {}),
        warning_count: validated.reduce(
          (sum, row) => sum + row.issues.filter((issue) => issue.severity === "warning").length,
          0,
        ),
      });

      // ── STEP 9/10 · One transaction: batch + rows + audit ─────────────────
      await withContext(ctx, async (tx) => {
        await tx`
          INSERT INTO public.import_batches (
            id, import_kind, original_file_name, row_count, valid_count, invalid_count,
            imported_count, status, dry_run, mapping, uploaded_by, validated_at, error_summary
          ) VALUES (
            ${batchId}::uuid,
            ${IMPORT_KIND}::text,
            ${fileName}::text,
            ${reconciliation.rowCount}::integer,
            ${reconciliation.validCount}::integer,
            ${reconciliation.invalidCount}::integer,
            0,
            'validated',
            true,
            ${batchMapping}::jsonb,
            ${auth.userId}::uuid,
            now(),
            ${errorSummary}::jsonb
          )
        `;

        // 200 rows per statement: `import_rows` is deliberately NOT audited
        // (migration 038 excludes it), so this is a plain bulk insert — the audit
        // trail describes the batch, not 5,000 staging rows.
        for (let i = 0; i < validated.length; i += 200) {
          const payload = JSON.stringify(
            validated.slice(i, i + 200).map((row) => ({
              row_number: row.rowNumber,
              // The source cells, verbatim. This object is the dispute record.
              raw: { ...row.raw, __csv_line: String(row.csvLine) },
              normalised: row.normalised,
              errors: row.issues.length === 0 ? null : row.issues,
              status: row.valid ? "valid" : "invalid",
            })),
          );
          await tx`
            INSERT INTO public.import_rows (batch_id, row_number, raw, normalised, errors, status)
            SELECT ${batchId}::uuid,
                   (x ->> 'row_number')::integer,
                   x -> 'raw',
                   x -> 'normalised',
                   NULLIF(x -> 'errors', 'null'::jsonb),
                   x ->> 'status'
              FROM jsonb_array_elements(${payload}::jsonb) AS x
          `;
        }

        // `trg_import_batches__audit` already recorded the INSERT field by
        // field. What it cannot say is what the operator was told, so the
        // reconciliation figures go on the chain explicitly.
        await writeAudit(tx, ctx, {
          action: "insert",
          entityTable: "public.import_batches",
          entityId: batchId,
          entityLabel: `${IMPORT_KIND}:${fileName}`,
          newValue: {
            row_count: reconciliation.rowCount,
            valid_count: reconciliation.validCount,
            invalid_count: reconciliation.invalidCount,
            file_sha256: fileSha,
            identifier_checksums: reconciliation.identifierChecksums,
            storage_path: objectPath,
          },
        });
      });
      uploaded = null; // committed: the object belongs to the batch now.

      const rejections = validated.filter((r) => !r.valid);
      const warnings = validated.filter((r) => r.valid && r.issues.length > 0);
      const responseBody = {
        mode: "stage" as const,
        batchId,
        importKind: IMPORT_KIND,
        company: { id: refs.companyId, code: refs.companyCode },
        file: { name: fileName, sha256: fileSha, byteSize: bytes.byteLength, storagePath: objectPath },
        columns: { mapped: mapping.mapped, count: mapping.specByIndex.size },
        totals: {
          rows: reconciliation.rowCount,
          valid: reconciliation.validCount,
          invalid: reconciliation.invalidCount,
          rowsWithWarnings: reconciliation.warningRowCount,
        },
        reconciliation: {
          nullCounts: reconciliation.nullCounts,
          identifierChecksums: reconciliation.identifierChecksums,
          spotCheck: reconciliation.spotCheck,
        },
        rejections: rejections.slice(0, MAX_REPORTED).map(reportRow),
        rejectionsTruncated: rejections.length > MAX_REPORTED,
        warnings: warnings.slice(0, MAX_REPORTED).map(reportRow),
        warningsTruncated: warnings.length > MAX_REPORTED,
        // §4.2 step 4: zero rejections, twice, before promotion.
        nextStep: reconciliation.invalidCount === 0
          ? "commit"
          : "fix-the-source-and-stage-again",
        reason,
        requestId,
      };
      status = 200;
      await store(idempotencyKey, status, responseBody);
      log.info("batch staged", {
        batch_id: batchId,
        rows: reconciliation.rowCount,
        valid: reconciliation.validCount,
        invalid: reconciliation.invalidCount,
      });
      return ok(responseBody, { status, headers: cors, requestId });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // COMMIT
    // ═══════════════════════════════════════════════════════════════════════
    const commitBody = commit as z.infer<typeof CommitBody>;

    interface BatchRow {
      id: string;
      import_kind: string;
      status: string;
      row_count: number;
      valid_count: number;
      invalid_count: number;
      imported_count: number;
      mapping: Record<string, unknown> | null;
      imported_at: Date | string | null;
      rollback_at: Date | string | null;
    }

    const batchRows = await db`
      SELECT b.id, b.import_kind, b.status, b.row_count, b.valid_count, b.invalid_count,
             b.imported_count, b.mapping, b.imported_at, b.rollback_at
        FROM public.import_batches b
       WHERE b.id = ${commitBody.batchId}::uuid
       LIMIT 1
    `;
    const batch = firstRow(batchRows as unknown as BatchRow[]);
    if (batch === null || batch.import_kind !== IMPORT_KIND) {
      throw notFound("No employee import batch with that id.", "BATCH_NOT_FOUND");
    }
    if (batch.rollback_at !== null) {
      throw conflict("That batch was rolled back and cannot be committed.", "BATCH_ROLLED_BACK");
    }
    if (batch.status === "completed") {
      throw conflict("That batch has already been imported.", "BATCH_ALREADY_IMPORTED");
    }
    if (batch.status !== "validated" && batch.status !== "importing") {
      throw conflict(
        `That batch is ${batch.status}; only a validated batch can be committed.`,
        "BATCH_NOT_VALIDATED",
      );
    }
    if (batch.invalid_count > 0) {
      throw conflict(
        `The batch still has ${batch.invalid_count} rejected row(s). Fix the source and stage again — ` +
          "a partial import is never performed.",
        "BATCH_HAS_REJECTIONS",
      );
    }

    const mappingRecord = (batch.mapping ?? {}) as Record<string, unknown>;
    const mappedColumns = (mappingRecord.columns ?? {}) as Record<string, string>;
    const companyCodeFromBatch = typeof mappingRecord.company_code === "string"
      ? mappingRecord.company_code
      : null;

    // Rebuild the header mapping from the stored source headers, so commit reads
    // the file exactly as stage did.
    const headers = Object.keys(mappedColumns);
    const specByIndex = new Map<number, ColumnSpec>();
    headers.forEach((header, index) => {
      const spec = SPEC_BY_ALIAS.get(mappedColumns[header] as string);
      if (spec !== undefined) specByIndex.set(index, spec);
    });
    const mapping: HeaderMapping = { headers, specByIndex, mapped: mappedColumns };
    if (specByIndex.size === 0) {
      throw conflict(
        "The batch has no usable column mapping; stage the file again.",
        "BATCH_MAPPING_MISSING",
      );
    }

    interface StagedRow {
      row_number: number;
      raw: Record<string, string>;
      status: string;
    }
    const stagedRows = await db`
      SELECT r.row_number, r.raw, r.status
        FROM public.import_rows r
       WHERE r.batch_id = ${commitBody.batchId}::uuid
       ORDER BY r.row_number
    `;
    const staged = stagedRows as unknown as StagedRow[];
    if (staged.length === 0) {
      throw conflict("That batch has no staged rows.", "BATCH_EMPTY");
    }

    const codes = new Set<string>();
    const emails = new Set<string>();
    const rawRows = staged.map((row) => {
      const raw: Record<string, string> = {};
      for (const header of headers) raw[header] = row.raw[header] ?? "";
      return { rowNumber: row.row_number, csvLine: Number(row.raw.__csv_line ?? row.row_number), raw };
    });
    const codeHeader = headers.find((h) => mappedColumns[h] === "employee_code");
    const managerHeader = headers.find((h) => mappedColumns[h] === "reporting_manager_code");
    const emailHeader = headers.find((h) => mappedColumns[h] === "work_email");
    for (const row of rawRows) {
      if (codeHeader !== undefined) codes.add((row.raw[codeHeader] ?? "").trim().toUpperCase());
      if (managerHeader !== undefined) codes.add((row.raw[managerHeader] ?? "").trim().toUpperCase());
      if (emailHeader !== undefined) emails.add((row.raw[emailHeader] ?? "").trim().toLowerCase());
    }

    // The employees created by an EARLIER chunk of this same commit are already
    // in the database, so re-validation must not read them as duplicates.
    const alreadyImported = new Set(
      staged.filter((r) => r.status === "imported").map((r) => r.row_number),
    );

    const refs = await withContext(ctx, (tx) =>
      loadRefData(tx, companyCodeFromBatch, [...codes], [...emails]));
    const validated = validateRows(rawRows, mapping, refs);

    const nowInvalid = validated.filter((r) => !r.valid && !alreadyImported.has(r.rowNumber));
    if (nowInvalid.length > 0) {
      // Re-validation is the whole point of running the validator twice: the
      // world moved between staging and committing. 409 with the offending rows
      // named, and not one employee inserted.
      throw problem(
        409,
        "Conflict",
        `${nowInvalid.length} staged row(s) no longer validate against the current configuration ` +
          "(a code was retired, or the employee now exists). Nothing was imported — stage the file again.",
        nowInvalid.slice(0, 50).flatMap((row) =>
          row.issues
            .filter((issue) => issue.severity === "error")
            .slice(0, 3)
            .map((issue) => ({
              pointer: `/rows/${row.rowNumber}/${issue.field ?? issue.column}`,
              code: issue.code,
              detail: issue.detail,
            }))
        ),
        { code: "BATCH_REVALIDATION_FAILED" },
      );
    }

    const pending = validated.filter(
      (r) => !alreadyImported.has(r.rowNumber) && r.rowNumber > (commitBody.resume?.afterRowNumber ?? 0),
    );

    const created: { rowNumber: number; employeeId: string; employeeCode: string }[] = [];
    let lastRowNumber = commitBody.resume?.afterRowNumber ?? 0;
    let deadlineHit = false;

    for (let i = 0; i < pending.length; i += COMMIT_CHUNK_ROWS) {
      if (log.elapsedMs() > WORK_DEADLINE_MS) {
        deadlineHit = true;
        break;
      }
      const chunk = pending.slice(i, i + COMMIT_CHUNK_ROWS);

      // ── STEP 9/10 · One transaction per chunk: context, inserts, audit ────
      const chunkCreated = await withContext(ctx, async (tx) => {
        await tx`
          UPDATE public.import_batches
             SET status = 'importing', dry_run = false
           WHERE id = ${commitBody.batchId}::uuid
             AND status <> 'importing'
        `;
        const out: { rowNumber: number; employeeId: string; employeeCode: string }[] = [];
        for (const row of chunk) {
          const outcome = await insertEmployee(tx, row, refs, "active");
          out.push({
            rowNumber: row.rowNumber,
            employeeId: outcome.employeeId,
            employeeCode: outcome.employeeCode,
          });
          // The employee is now a valid manager target for later rows.
          refs.employeesByCode.set(outcome.employeeCode.toUpperCase(), outcome.employeeId);

          await tx`
            UPDATE public.import_rows
               SET status               = 'imported',
                   normalised           = ${JSON.stringify(row.normalised)}::jsonb,
                   created_entity_table = 'public.employees',
                   created_entity_id    = ${outcome.employeeId}::uuid
             WHERE batch_id = ${commitBody.batchId}::uuid
               AND row_number = ${row.rowNumber}::integer
          `;

          // The ONLY record of "this employee came from this batch, this line":
          // there is no employees.import_batch_id column (see the header note).
          await writeAudit(tx, ctx, {
            action: "insert",
            entityTable: "public.employees",
            entityId: outcome.employeeId,
            entityLabel: outcome.employeeCode,
            subjectEmployeeId: outcome.employeeId,
            newValue: {
              import_batch_id: commitBody.batchId,
              import_row_number: row.rowNumber,
              csv_line: row.csvLine,
              satellites: outcome.satellites,
            },
          });
        }
        return out;
      });

      created.push(...chunkCreated);
      lastRowNumber = chunk[chunk.length - 1]?.rowNumber ?? lastRowNumber;
    }

    // ── Manager links, once every employee in the batch exists ──────────────
    // Deferred deliberately: a manager may appear BELOW their reportee in the
    // file, and `trg_employees__no_manager_cycle` still guards the result.
    let managersLinked = 0;
    const remaining = pending.length - created.length;
    if (remaining === 0 && managerHeader !== undefined) {
      managersLinked = await withContext(ctx, async (tx) => {
        let linked = 0;
        for (const row of validated) {
          const managerCode = str(row.normalised, "reporting_manager_code");
          const selfCode = row.employeeCode;
          if (managerCode === null || selfCode === null) continue;
          const managerId = refs.employeesByCode.get(managerCode.toUpperCase()) ?? null;
          const selfId = refs.employeesByCode.get(selfCode.toUpperCase()) ?? null;
          if (managerId === null || selfId === null || managerId === selfId) continue;
          const updated = await tx`
            UPDATE public.employees
               SET reporting_manager_id = ${managerId}::uuid
             WHERE id = ${selfId}::uuid
               AND reporting_manager_id IS DISTINCT FROM ${managerId}::uuid
             RETURNING id
          `;
          if ((updated as unknown as unknown[]).length > 0) linked += 1;
        }
        return linked;
      });
    }

    const totalImported = batch.imported_count + created.length;
    const partial = deadlineHit || remaining > 0;

    await withContext(ctx, async (tx) => {
      await tx`
        UPDATE public.import_batches
           SET imported_count = ${totalImported}::integer,
               status         = ${partial ? "importing" : "completed"}::text,
               imported_at    = CASE WHEN ${partial}::boolean THEN imported_at ELSE now() END
         WHERE id = ${commitBody.batchId}::uuid
      `;
      if (!partial) {
        await writeAudit(tx, ctx, {
          action: "insert",
          entityTable: "public.import_batches",
          entityId: commitBody.batchId,
          entityLabel: `${IMPORT_KIND}:committed`,
          newValue: {
            imported_count: totalImported,
            managers_linked: managersLinked,
            row_count: batch.row_count,
          },
        });
      }
    });

    const responseBody = {
      mode: "commit" as const,
      batchId: commitBody.batchId,
      status: partial ? "importing" : "completed",
      totals: {
        rows: batch.row_count,
        importedThisCall: created.length,
        importedTotal: totalImported,
        alreadyImported: alreadyImported.size,
        remaining: Math.max(0, remaining),
      },
      managersLinked,
      created: created.slice(0, MAX_REPORTED),
      createdTruncated: created.length > MAX_REPORTED,
      partial,
      resume: partial ? { afterRowNumber: lastRowNumber } : null,
      reason,
      requestId,
    };
    status = 200;

    // ── STEP 11 · Store the response under the idempotency key ─────────────
    await store(idempotencyKey, status, responseBody);
    log.info("batch committed", {
      batch_id: commitBody.batchId,
      imported: created.length,
      total: totalImported,
      partial,
    });
    return ok(responseBody, { status, headers: cors, requestId });
  } catch (err) {
    const mapped = isProblem(err) ? err : mapPgError(err);
    const asProblem = toProblem(mapped, requestId).withContext({ requestId, instance });
    status = asProblem.status;

    if (uploaded !== null) {
      try {
        await serviceClient().storage.from(uploaded.bucket).remove([uploaded.path]);
        log.warn("rolled back staged source file", { bucket: uploaded.bucket });
      } catch (removeErr) {
        log.error("orphaned import object", { bucket: uploaded.bucket, path: uploaded.path, err: removeErr });
      }
    }

    if (idempotencyKey !== null) {
      try {
        if (status >= 500) await release(idempotencyKey);
        else await store(idempotencyKey, status, asProblem.problem);
      } catch (storeErr) {
        log.warn("could not finalise idempotency key", { key: idempotencyKey, err: storeErr });
      }
    }

    if (asProblem.isServerFault) log.error("unhandled failure", { err, code: asProblem.code });
    else log.warn("request refused", { code: asProblem.code, status });
    return asProblem.toResponse(cors);
  } finally {
    // ── STEP 12 · One structured log line per invocation ────────────────────
    log.finish(status, { idempotency_key: idempotencyKey });
  }
});

/**
 * Turn the constraint violations that CAN still reach us into caller-safe
 * problems. The validator is meant to catch these first; when one arrives it
 * means the database knows something the importer does not, which is a 409 the
 * operator can act on — never a 500 with SQL in it.
 */
function mapPgError(err: unknown): unknown {
  const e = (err !== null && typeof err === "object" ? err : {}) as {
    code?: string;
    constraint_name?: string;
  };
  switch (e.code) {
    case "23505":
      return conflict(
        `A duplicate row was refused by the database (${e.constraint_name ?? "unique index"}). ` +
          "Nothing further was imported.",
        "DUPLICATE_ROW",
        { cause: err },
      );
    case "23514":
      return conflict(
        `A database rule rejected a staged row (${e.constraint_name ?? "check constraint"}). ` +
          "Nothing further was imported.",
        "DB_CHECK_REJECTED",
        { cause: err },
      );
    case "23503":
      return conflict(
        "A referenced record (department, designation, grade, location or manager) no longer exists.",
        "REFERENCE_MISSING",
        { cause: err },
      );
    case "22023":
      return conflict("The database refused an immutable-column change.", "IMMUTABLE_COLUMN", { cause: err });
    default:
      return err;
  }
}

/** Exported so `supabase/tests` and the admin console assert against one schema. */
export { CommitBody, COLUMNS, inspectCell, parseCsv, StageFields, validateRows };
