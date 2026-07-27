/**
 * regularizations.api.ts — every E-04 read and write, and nothing else.
 *
 * Schemas mirror the DEPLOYED `attendance_regularizations` table (migration
 * 20260801001700 §3) column for column. Where spec-employee §5 E-04 names a
 * field the deployed table does not have (`on_duty_purpose`,
 * `on_duty_location`, `override_ack`, an `applied_attendance_day_id`), the field
 * is ABSENT here rather than faked — see the notes at each site.
 *
 * NO ARITHMETIC on attendance. The "current record" panel and the preview read
 * the SAME server row the month grid reads (`v_attendance_day_enriched` via
 * `attendance.api.ts`), which is why the form and E-03 cannot disagree.
 *
 * Quota: `used` is the COUNT OF THE EXACT ROWS RETURNED for the month, and
 * `cap` is `attendance_policies.max_regularizations_per_month` resolved by the
 * server (`resolve_policy`). Neither number is guessed, and the BEFORE INSERT
 * trigger `attendance_regularizations_window_guard` is the real enforcer — the
 * UI only tells the truth earlier.
 */
import { z } from "zod";
import {
  QueryError,
  dbDate,
  dbDateNullable,
  dbInt,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  gte,
  inList,
  lte,
  rpcOne,
  selectMany,
  selectOne,
} from "@/shared/api/query";
import { invokeEdgeFn } from "@/shared/api/invoke";
import { addIstDays } from "@/lib/datetime";
import { supabase } from "@/lib/supabase";

export const REGULARIZATIONS_TABLE = "attendance_regularizations";
export const ATTENDANCE_POLICIES_TABLE = "attendance_policies";
export const RESOLVE_POLICY_FN = "resolve_policy";

/**
 * `ck_ar__kind` (migration 017). These are the DEPLOYED kinds; spec-employee §5
 * names `missed_checkin/missed_checkout/short_day`, which the CHECK constraint
 * does not accept. The constraint wins — a request the DB refuses is not a
 * feature.
 */
export const regularizationKindValues = [
  "missed_in",
  "missed_out",
  "missed_both",
  "wrong_time",
  "marked_absent",
  "on_duty",
  "work_from_home",
  "shift_mismatch",
  "break_correction",
] as const;

export const regularizationKindSchema = z.enum(regularizationKindValues);
export type RegularizationKind = z.infer<typeof regularizationKindSchema>;

/** `public.regularization_status` (migration 003). */
export const regularizationStatusSchema = z.enum([
  "draft",
  "pending",
  "approved",
  "rejected",
  "cancelled",
  "applied",
]);
export type RegularizationStatus = z.infer<typeof regularizationStatusSchema>;

/** Statuses that hold a slot against the monthly cap (mirrors the trigger). */
export const QUOTA_COUNTING_STATUSES = ["draft", "pending", "approved", "applied"] as const;

/** Kinds where the request is a TIME correction and both times are meaningful. */
export const TIME_KINDS: readonly RegularizationKind[] = [
  "missed_in",
  "missed_out",
  "missed_both",
  "wrong_time",
  "break_correction",
  "shift_mismatch",
];

/** Kinds where the request sets a day STATUS rather than times. */
export const STATUS_KINDS: readonly RegularizationKind[] = ["on_duty", "work_from_home"];

/** spec-employee §5 E-04: evidence is mandatory for `marked_absent`. */
export const EVIDENCE_MANDATORY_KINDS: readonly RegularizationKind[] = ["marked_absent"];

// -----------------------------------------------------------------------------
// 1. My requests
// -----------------------------------------------------------------------------

export const regularizationSchema = z.object({
  id: dbUuid,
  employee_id: dbUuid,
  ist_date: dbDate,
  attendance_day_id: dbUuidNullable,
  regularization_kind: regularizationKindSchema,
  requested_first_in_at: dbTimestampNullable,
  requested_last_out_at: dbTimestampNullable,
  /** 'on_duty' | 'work_from_home' | null — never a free-form status. */
  requested_status: z.string().nullable(),
  employee_reason: z.string(),
  supporting_document_id: dbUuidNullable,
  status: regularizationStatusSchema,
  approval_request_id: dbUuidNullable,
  decided_at: dbTimestampNullable,
  decision_comment: z.string().nullable(),
  applied_at: dbTimestampNullable,
  /**
   * Stamped by the window-guard trigger: which slot of the monthly cap this
   * request took. Displayed, never recomputed.
   */
  month_quota_counter: z.number().int().nullable(),
  created_at: z.string(),
});

export type Regularization = z.infer<typeof regularizationSchema>;

const REGULARIZATION_COLUMNS =
  "id, employee_id, ist_date, attendance_day_id, regularization_kind, " +
  "requested_first_in_at, requested_last_out_at, requested_status, employee_reason, " +
  "supporting_document_id, status, approval_request_id, decided_at, decision_comment, " +
  "applied_at, month_quota_counter, created_at";

/**
 * There is no `REG-YYYY-NNNN` column on the deployed table (spec-employee §5
 * E-04 asks for one). The linked `approval_requests.request_number` is the real
 * server-issued reference; until a request is routed we show a short id so the
 * employee can quote something. We do NOT mint a fake sequence.
 */
export function regularizationRef(row: Regularization): string {
  return row.id.slice(0, 8).toUpperCase();
}

/** My correction requests, newest first. */
export async function fetchMyRegularizations(
  employeeId: string,
  signal?: AbortSignal,
): Promise<Regularization[]> {
  return selectMany(REGULARIZATIONS_TABLE, regularizationSchema, {
    columns: REGULARIZATION_COLUMNS,
    filters: [eq("employee_id", employeeId)],
    order: [
      { column: "ist_date", ascending: false },
      { column: "created_at", ascending: false },
    ],
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

/** Requests dated inside one calendar month — the quota series. */
export async function fetchRegularizationsForMonth(
  employeeId: string,
  monthFrom: string,
  monthTo: string,
  signal?: AbortSignal,
): Promise<Regularization[]> {
  return selectMany(REGULARIZATIONS_TABLE, regularizationSchema, {
    columns: REGULARIZATION_COLUMNS,
    filters: [
      eq("employee_id", employeeId),
      gte("ist_date", monthFrom),
      lte("ist_date", monthTo),
      inList("status", QUOTA_COUNTING_STATUSES),
    ],
    order: [{ column: "ist_date", ascending: true }],
    limit: 100,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 2. The policy behind the quota and the date window
// -----------------------------------------------------------------------------

export const regularizationPolicySchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  regularization_window_days: dbInt,
  max_regularizations_per_month: dbInt,
  regularization_requires_manager: z.boolean(),
});

export type RegularizationPolicy = z.infer<typeof regularizationPolicySchema>;

/**
 * The attendance policy in force for this employee on this date, resolved by the
 * SERVER (`resolve_policy` walks employee → designation → grade → section →
 * department → employment type → location → company precedence). We never pick a
 * policy row ourselves: two policies with different caps exist in the seed.
 *
 * `null` means no assignment covers the date — the caller must then say so
 * rather than substituting the column defaults.
 */
export async function fetchRegularizationPolicy(
  employeeId: string,
  isoDate: string,
  signal?: AbortSignal,
): Promise<RegularizationPolicy | null> {
  const policyId = await rpcOne(
    RESOLVE_POLICY_FN,
    { p_kind: "attendance_policy", p_employee_id: employeeId, p_date: isoDate },
    z.string().uuid(),
    signal ? { signal } : {},
  );
  if (policyId === null) return null;
  return selectOne(
    ATTENDANCE_POLICIES_TABLE,
    regularizationPolicySchema,
    [eq("id", policyId)],
    {
      columns:
        "id, code, name, regularization_window_days, max_regularizations_per_month, regularization_requires_manager",
      ...(signal ? { signal } : {}),
    },
  );
}

// -----------------------------------------------------------------------------
// 3. The live server preview (dry run)
// -----------------------------------------------------------------------------

/**
 * What the day WOULD look like after approval, computed by the server.
 *
 * spec-employee §5 E-04 specifies this as `fn_rollup_attendance_day` in
 * **dry_run** mode, applied inside the `attendance-apply-regularization` edge
 * function. Neither is deployed (migrations 017/018 expose only
 * `compute_attendance_day`, which WRITES, and there is no such edge function),
 * so this call fails until they ship. The UI must then show the honest
 * "preview unavailable" state and the current-vs-requested comparison — it must
 * NOT compute worked minutes or a day status in the browser. That client-side
 * recomputation is the exact defect class this build exists to remove.
 */
export const regularizationPreviewSchema = z.object({
  ist_date: dbDate,
  status: z.string(),
  first_in_at: dbTimestampNullable,
  last_out_at: dbTimestampNullable,
  total_worked_minutes: z.number().int().nullable(),
  late_minutes: z.number().int().nullable(),
  day_fraction_paid: z.union([z.number(), z.string()]).nullable(),
});

export type RegularizationPreview = z.infer<typeof regularizationPreviewSchema>;

export interface RegularizationPreviewInput {
  readonly employeeId: string;
  readonly istDate: string;
  readonly kind: RegularizationKind;
  readonly requestedFirstInAt: string | null;
  readonly requestedLastOutAt: string | null;
  readonly requestedStatus: string | null;
}

export const REGULARIZATION_APPLY_FN = "attendance-apply-regularization";

export async function fetchRegularizationPreview(
  input: RegularizationPreviewInput,
  signal?: AbortSignal,
): Promise<RegularizationPreview> {
  return invokeEdgeFn(
    REGULARIZATION_APPLY_FN,
    {
      dry_run: true,
      employee_id: input.employeeId,
      ist_date: input.istDate,
      regularization_kind: input.kind,
      requested_first_in_at: input.requestedFirstInAt,
      requested_last_out_at: input.requestedLastOutAt,
      requested_status: input.requestedStatus,
    },
    regularizationPreviewSchema,
    signal ? { signal } : {},
  );
}

// -----------------------------------------------------------------------------
// 4. Submit / withdraw
// -----------------------------------------------------------------------------

export interface SubmitRegularizationInput {
  readonly employeeId: string;
  readonly istDate: string;
  readonly kind: RegularizationKind;
  readonly requestedFirstInAt: string | null;
  readonly requestedLastOutAt: string | null;
  readonly requestedStatus: string | null;
  readonly reason: string;
  readonly supportingDocumentId: string | null;
}

/**
 * Insert the request as `pending`.
 *
 * Idempotency: the deployed table has no idempotency-key column, but
 * `uq_ar__one_open_per_day` (partial unique on employee+date while
 * draft/pending) makes a double submit STRUCTURALLY impossible. A replay
 * therefore surfaces as `23505`, which `QueryError` maps to `kind: "conflict"` —
 * the mutation UI treats it exactly like the `409 idempotent_replay` the
 * contract describes: the intended state already exists, so it is success.
 *
 * The window, the monthly cap and `attendance_regularize_from` are enforced by
 * the BEFORE INSERT trigger, not here. This function does not pre-empt them; it
 * surfaces their message.
 */
export async function submitRegularization(
  input: SubmitRegularizationInput,
): Promise<Regularization> {
  const { data, error } = await supabase
    .from(REGULARIZATIONS_TABLE)
    .insert({
      employee_id: input.employeeId,
      ist_date: input.istDate,
      regularization_kind: input.kind,
      requested_first_in_at: input.requestedFirstInAt,
      requested_last_out_at: input.requestedLastOutAt,
      requested_status: input.requestedStatus,
      employee_reason: input.reason,
      supporting_document_id: input.supportingDocumentId,
      status: "pending",
    })
    .select(REGULARIZATION_COLUMNS)
    .single();

  if (error) {
    throw new QueryError(
      REGULARIZATIONS_TABLE,
      error.code === "23505" ? "conflict" : error.code === "42501" ? "no_permission" : "unknown",
      error.message,
      { code: error.code ?? null, details: error.details ?? null, hint: error.hint ?? null, cause: error },
    );
  }
  return regularizationSchema.parse(data);
}

/**
 * Withdraw a request the employee still owns. RLS
 * (`attendance_regularizations__self_cancel`) allows the transition only from
 * draft/pending, so a raced approval is refused by the database, not by us.
 */
export async function withdrawRegularization(id: string): Promise<void> {
  const { error } = await supabase
    .from(REGULARIZATIONS_TABLE)
    .update({ status: "cancelled" })
    .eq("id", id);
  if (error) {
    throw new QueryError(REGULARIZATIONS_TABLE, "unknown", error.message, {
      code: error.code ?? null,
      cause: error,
    });
  }
}

// -----------------------------------------------------------------------------
// 5. Evidence upload
// -----------------------------------------------------------------------------

export const EVIDENCE_BUCKET = "documents";
export const EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;
export const EVIDENCE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

/**
 * Upload one evidence file into the caller's own folder.
 *
 * The storage policy `documents__own_write` requires
 * `(storage.foldername(name))[2] = current_employee_id()`, i.e. the path must be
 * `<prefix>/<employee_id>/<file>` — that is why the prefix segment exists.
 *
 * Registering the file in `public.documents` (so it can be referenced as
 * `supporting_document_id`) needs an INSERT policy for self that migration 025
 * does not create, and the read path needs the `document-access` edge function
 * that is not deployed. This function therefore returns the storage path only;
 * the caller must treat a missing document row as a blocking, honest error
 * rather than submitting a request whose evidence nobody can open.
 */
export async function uploadRegularizationEvidence(
  employeeId: string,
  file: File,
): Promise<{ bucket: string; path: string }> {
  const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".") + 1) : "bin";
  const path = `regularization-evidence/${employeeId}/${crypto.randomUUID()}.${ext.toLowerCase()}`;
  const { error } = await supabase.storage
    .from(EVIDENCE_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });
  if (error) {
    throw new QueryError(`storage/${EVIDENCE_BUCKET}`, "no_permission", error.message, {
      cause: error,
    });
  }
  return { bucket: EVIDENCE_BUCKET, path };
}

// -----------------------------------------------------------------------------
// 6. Date helpers that are pure calendar facts, not business arithmetic
// -----------------------------------------------------------------------------

/** Inclusive bounds of the calendar month containing `isoDate` ('YYYY-MM-DD'). */
export function monthBounds(isoDate: string): { from: string; to: string; month: string } {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(isoDate);
  if (!m) throw new RangeError(`Invalid civil date: ${isoDate}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, "0");
  return {
    from: `${year}-${mm}-01`,
    to: `${year}-${mm}-${String(lastDay).padStart(2, "0")}`,
    month: `${year}-${mm}`,
  };
}

/**
 * Re-exported from lib/datetime, which is the only sanctioned home for
 * date/time conversion. Kept as a named re-export so the form's existing
 * import site does not have to change.
 */
export { istWallClockToInstant } from "@/lib/datetime";

/**
 * Civil date `days` before `isoDate`, for the "window opens on" line.
 *
 * Delegates to `addIstDays`, which does civil-date arithmetic on a noon-UTC
 * anchor. The hand-rolled version this replaced was off by one EVERY time: it
 * built an instant from IST midnight (`…T00:00:00+05:30`, i.e. 18:30 UTC on the
 * PREVIOUS day), subtracted whole days, then read `getUTCDate()` back off it —
 * so a 15-day regularisation window measured from 2026-07-25 opened on
 * 2026-07-09 instead of 2026-07-10. The form used that value to decide whether
 * a date was still inside the policy window, so it accepted one day the server
 * would reject and printed the wrong date to the employee.
 */
export function civilDateMinusDays(isoDate: string, days: number): string {
  return addIstDays(isoDate, -days);
}

/** Nullable date passthrough used by the schemas above. */
export type MaybeDate = z.infer<typeof dbDateNullable>;
