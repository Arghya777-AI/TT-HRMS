/**
 * payslip-publish — catalogue #10, auth model **U+** (`payroll.publish`, step-up).
 *
 * Two-person approve → render payslip PDFs server-side → store → register as
 * hashed documents → enqueue notifications. Batched and re-runnable: a payslip
 * that already has `pdf_document_id` is skipped, so a timeout half way through
 * 200 employees is fixed by calling again, not by starting over.
 *
 * THE TWO-PERSON RULE, three times over (spec-architecture §6, threat T-07)
 *   1. `role_capabilities.requires_step_up` → `payroll.publish` demands `aal2`.
 *   2. THIS function refuses `approved_by = computed_by` with a clean 403 and a
 *      machine code the UI can act on.
 *   3. `trg_payroll_runs__two_person` (022) refuses it again inside the
 *      transaction — including the "variance > ±10% needs an acknowledgement
 *      reason" rule, which `app.reason` (from the mandatory `reason` field)
 *      satisfies. Layer 3 is the boundary; layers 1 and 2 exist so the operator
 *      gets a sentence instead of a SQLSTATE.
 *   Plus gate 4 of the payroll pipeline (spec-admin §"Gates"): the approver must
 *   TYPE the net-pay total. `confirm_net_total_paise` must equal
 *   `payroll_runs.total_net_paise` to the paise, or nothing happens.
 *
 * WHAT "PUBLISHED" MEANS HERE
 *   `payroll_runs.status = 'approved'` is the release switch: it is what
 *   `public.payroll_run_is_released()` tests, and therefore what makes a payslip
 *   visible to the employee (RLS on `payslips`, 022) and its PDF readable from
 *   Storage (`payslips__own_read`, 039). Per payslip, published means
 *   `pdf_document_id` + `pdf_generated_at` are set and the PDF object exists at
 *   the canonical path. `emailed_at` is NOT set here — `notification-dispatch`
 *   (#14) owns that, and claiming delivery we have not performed would be a lie
 *   in an audited column.
 *
 * ORDERING (deliberate): approve FIRST, then render. The Storage policy only
 * lets an employee read the object once the run is released, and a PDF written
 * before approval would be an unreleased payslip sitting in a bucket. The reverse
 * order would also mean a failed render leaves the run un-approved with half its
 * PDFs written.
 *
 * STORAGE PATH — `<company_id>/<financial_year>/<employee_code>/<number>.pdf`,
 * fixed by the `payslips__own_read` policy (039), which matches
 * `(storage.foldername(name))[3]` against `employees.employee_code`.
 * `payslip_number` is `TT0007/2026-07` (023) — the slash is stripped, otherwise
 * the number would silently become another folder level.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import {
  conflict,
  forbidden,
  isProblem,
  locked,
  methodNotAllowed,
  notFound,
  ok,
  serverError,
  toProblem,
  unprocessable,
} from "../_shared/errors.ts";
import { common, parseBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { financialYear, istTimestamp, nowIso } from "../_shared/datetime.ts";
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
import { requireCapWithStepUp, verifyUser } from "../_shared/auth.ts";
import { enforce, limitKey, RATE_LIMITS } from "../_shared/ratelimit.ts";
import { auditJobRun } from "../_shared/audit.ts";
import {
  claim,
  release,
  replayResponse,
  requestHash,
  requireIdempotencyKey,
  store,
} from "../_shared/idempotency.ts";
import {
  amountInWordsInr,
  latin1,
  maskTail,
  type PayslipLineInput,
  renderPayslipPdf,
} from "./render.ts";

const FN_NAME = "payslip-publish";
const CAP = "payroll.publish";
const JOB_CODE = "payslip_publish";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;
const BUCKET = "payslips";
/** `document_types.code` seeded in migration 042. */
const DOCUMENT_TYPE_CODE = "PAYSLIP";
/** `notification_templates.code` / `notifications.event_code` seeded in 045. */
const EVENT_CODE = "PAYSLIP_READY";
const DEFAULT_BATCH_SIZE = 25;
/** Statuses from which a first approval is legal. */
const APPROVABLE_STATUSES = ["computed", "in_review"] as const;
/** Statuses in which the run is already released and only rendering remains. */
const RELEASED_STATUSES = ["approved", "disbursement_pending", "paid"] as const;

const PublishBody = z
  .object({
    payroll_run_id: common.uuid,
    /**
     * Gate 4: the approver types the run's net-pay total. Compared to
     * `payroll_runs.total_net_paise` exactly — integer paise, no tolerance.
     */
    confirm_net_total_paise: common.paise,
    /**
     * Mandatory. `public.payroll_runs` and `public.documents` are in
     * `audit.reason_required_tables` (006), AND the 022 guard demands
     * `app.has_reason()` when |variance| > 10%.
     */
    reason: common.reason,
    /** Payslips rendered per invocation. Call again while `done` is false. */
    batch_size: z.number().int().min(1).max(100).optional(),
    /** Skip the notification enqueue (a re-render of an already-notified run). */
    notify: z.boolean().optional(),
  })
  .strict();

// ── Row shapes. postgres.js hydrates int8/numeric as STRINGS. ───────────────

interface RunRow {
  id: string;
  company_id: string;
  run_number: string;
  run_kind: string;
  status: string;
  pay_period_id: string;
  computed_by: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  total_net_paise: string;
  variance_vs_previous_pct: string | null;
  error_count: string;
  period_name: string;
  period_start: string;
  period_end: string;
  financial_year: string | null;
}

interface PayslipRow {
  id: string;
  employee_id: string;
  payslip_number: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  period_days: number;
  paid_days: string;
  lop_days: string;
  present_days: string;
  weekly_off_days: string;
  holiday_days: string;
  leave_days_paid: string;
  leave_days_unpaid: string;
  overtime_minutes: number;
  late_deduction_days: string;
  gross_earnings_paise: string;
  total_deductions_paise: string;
  net_pay_paise: string;
  net_pay_words: string | null;
  employer_contributions_paise: string;
  ytd_gross_paise: string;
  ytd_deductions_paise: string;
  ytd_net_paise: string;
  ytd_tds_paise: string;
  payment_mode: string;
  employee_code: string;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  profile_id: string | null;
  date_of_join: string | null;
  designation_name: string | null;
  department_name: string | null;
  location_name: string | null;
  bank_name: string | null;
  bank_ifsc: string | null;
  bank_account_number: string | null;
  uan: string | null;
  pf_number: string | null;
  esi_number: string | null;
  employee_pan: string | null;
  company_legal_name: string;
  company_trade_name: string | null;
  company_pan: string | null;
  company_tan: string | null;
  company_pf_code: string | null;
  company_esi_code: string | null;
  company_address: Record<string, unknown> | null;
}

interface LineRow {
  label: string;
  line_kind: string;
  sequence: number;
  full_month_amount_paise: string;
  amount_paise: string;
  ytd_amount_paise: string;
  is_prorated: boolean;
  is_arrear: boolean;
}

interface PublishedPayslip {
  payslip_id: string;
  employee_code: string;
  payslip_number: string;
  document_id: string;
  storage_path: string;
  checksum_sha256: string;
  size_bytes: number;
  page_count: number;
  net_paise: number;
}

function asNum(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asNumOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * SHA-256 of the EXACT bytes stored, so `documents.checksum_sha256` proves the
 * object in the bucket and not a re-render of it.
 *
 * `_shared/auth.ts`'s `sha256Hex` takes a string and UTF-8-encodes it, which
 * mangles every byte above 0x7F — it cannot be used to hash a PDF.
 */
async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  // Copy into a freshly allocated ArrayBuffer first: `crypto.subtle.digest`
  // requires a BufferSource backed by an ArrayBuffer (never a SharedArrayBuffer),
  // and pdf-lib's `save()` returns an unparameterised Uint8Array.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function pgCode(err: unknown): string | null {
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

function mapPgError(err: unknown): never {
  if (isProblem(err)) throw err;
  switch (pgCode(err)) {
    case "55P03":
      throw conflict(
        "This payroll run is already being published. Wait for the current step to finish.",
        "PAYROLL_RUN_IN_PROGRESS",
        { cause: err },
      );
    case "0A000":
      throw conflict(
        "This payroll run is closed or cancelled and can no longer be published.",
        "PAYROLL_RUN_NOT_MUTABLE",
        { cause: err },
      );
    case "23514":
      // The 022 guard: two-person rule, unresolved errors, or an unacknowledged
      // variance. All three are the operator's to resolve.
      throw conflict(
        "The payroll guard refused this approval. Check the two-person rule, the run's exceptions and the variance acknowledgement.",
        "PAYROLL_GUARD_REFUSED",
        { cause: err },
      );
    case "42501":
      throw forbidden("You do not have permission to publish this payroll run.", "CAP_REQUIRED", {
        cause: err,
      });
    default:
      throw err;
  }
}

/**
 * Storage-safe path segment. `payslip_number` legitimately contains `/`
 * (`TT0007/2026-07`), which Storage reads as a folder separator and which would
 * push `employee_code` out of `foldername()[3]` for anything that assumed a
 * fixed depth.
 */
function pathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function addressLines(address: Record<string, unknown> | null): string[] {
  if (address === null) return [];
  const pick = (key: string): string => {
    const v = address[key];
    return typeof v === "string" ? v.trim() : "";
  };
  const cityLine = [pick("city"), pick("state"), pick("pincode")].filter((v) => v !== "").join(", ");
  return [pick("line1"), pick("line2"), pick("line3"), cityLine, pick("country")]
    .map((l) => latin1(l))
    .filter((l) => l !== "");
}

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

  try {
    assertOriginAllowed(req);

    // ── STEP 4 · Auth (model U) ─────────────────────────────────────────────
    const auth = await verifyUser(req);
    const pool = sql();

    // ── STEP 5 · Authority: capability + step-up, both from the DB ──────────
    // `payroll.publish` carries `requires_step_up = true` (050 §2) — this is the
    // U+ enforcement point for the single most sensitive action in the product.
    await requireCapWithStepUp(pool, auth, CAP);

    // ── STEP 6 · Rate limit ────────────────────────────────────────────────
    //
    // Two tiers, same reasoning as `payroll-run`: publishing 200 payslips is
    // eight calls, and `heavyJob` (4 burst + 2/min) would stall it in 429s. The
    // per-call limit is the ordinary `mutation` bucket; the `heavyJob` token is
    // spent below, only when a NEW publish job is begun.
    await enforce(RATE_LIMITS.mutation, limitKey(FN_NAME, auth.userId), "PAYROLL_RATE_LIMITED", pool);

    // ── STEP 7 · Validate ──────────────────────────────────────────────────
    const { data: body, raw } = await parseBody(req, PublishBody, { maxBytes: 8 * 1024 });
    const batchSize = body.batch_size ?? DEFAULT_BATCH_SIZE;
    const shouldNotify = body.notify !== false;

    // ── STEP 8 · Idempotency claim ─────────────────────────────────────────
    idempotencyKey = requireIdempotencyKey(req);
    const hash = await requestHash(FN_NAME, raw, auth.userId);
    const claimed = await claim(
      { key: idempotencyKey, fnName: FN_NAME, requestHash: hash, actorId: auth.userId },
      pool,
    );
    if (claimed.state === "replay") {
      status = claimed.status;
      log.info("idempotent replay", { key: idempotencyKey, payroll_run_id: body.payroll_run_id });
      return replayResponse(claimed, { ...cors, "x-request-id": requestId });
    }

    // ── STEP 9 · app.set_context + ONE transaction ─────────────────────────
    const ctx: RequestContext = {
      actorId: auth.userId,
      actorRole: auth.role,
      source: "web_admin",
      sourceRoute: FN_NAME,
      requestId,
      ip: clientIpFrom(req),
      ua: userAgentFrom(req),
      reason: body.reason,
    };

    const storage = serviceClient().storage.from(BUCKET);

    const outcome = await withContext(ctx, async (tx) => {
      // 9a · Take the run. NOWAIT: two approvers hitting publish at once must
      // not both render.
      const runRows = await tx<RunRow[]>`
        SELECT r.id,
               r.company_id,
               r.run_number,
               r.run_kind,
               r.status::text AS status,
               r.pay_period_id,
               r.computed_by,
               r.approved_by,
               r.approved_at,
               r.total_net_paise,
               r.variance_vs_previous_pct,
               (SELECT COUNT(*) FROM public.payroll_run_employees pre
                 WHERE pre.payroll_run_id = r.id AND pre.status = 'error') AS error_count,
               pp.name             AS period_name,
               -- ::text on every date column: postgres.js hydrates a date column
               -- to a JS Date, and a Date interpolated into a PDF prints
               -- "Wed Jul 01 2026 00:00:00 GMT+0000".
               pp.start_date::text AS period_start,
               pp.end_date::text   AS period_end,
               pp.financial_year
          FROM public.payroll_runs r
          JOIN public.pay_periods  pp ON pp.id = r.pay_period_id
         WHERE r.id = ${body.payroll_run_id}::uuid
         FOR UPDATE OF r NOWAIT
      `;
      const run = firstRow(runRows);
      if (run === null) throw notFound(undefined, "PAYROLL_RUN_NOT_FOUND");

      const alreadyReleased = (RELEASED_STATUSES as readonly string[]).includes(run.status);
      const canApprove = (APPROVABLE_STATUSES as readonly string[]).includes(run.status);

      if (run.status === "closed") {
        throw locked(
          `Run ${run.run_number} is closed; corrections require an arrears run.`,
          "PAYROLL_RUN_CLOSED",
        );
      }
      if (run.status === "cancelled") {
        throw conflict(`Run ${run.run_number} was cancelled.`, "PAYROLL_RUN_NOT_MUTABLE");
      }
      if (!alreadyReleased && !canApprove) {
        // draft / inputs_locked / failed — nothing to approve yet.
        throw conflict(
          `Run ${run.run_number} is ${run.status}; compute it before publishing.`,
          "PAYROLL_RUN_NOT_COMPUTED",
        );
      }

      // 9b · Gate 4: typed net-pay total. Checked before anything is written.
      const runNet = asNum(run.total_net_paise);
      if (body.confirm_net_total_paise !== runNet) {
        throw unprocessable(
          [{
            pointer: "/confirm_net_total_paise",
            code: "mismatch",
            detail: "The typed net-pay total does not match this run's net total.",
          }],
          "Confirm the run's net-pay total exactly, in paise, before publishing.",
          "PAYROLL_NET_TOTAL_MISMATCH",
        );
      }

      // 9c · Two-person rule, stated in plain language before the trigger states
      // it in SQLSTATE. A run with no `computed_by` was never computed by an
      // identified person and cannot satisfy the rule at all.
      if (!alreadyReleased) {
        if (run.computed_by === null) {
          throw conflict(
            `Run ${run.run_number} has no recorded preparer; recompute it before approval.`,
            "PAYROLL_PREPARER_UNKNOWN",
          );
        }
        if (run.computed_by === auth.userId) {
          throw forbidden(
            "The person who computed a payroll run cannot approve it. A second authorised approver must publish.",
            "PAYROLL_TWO_PERSON_REQUIRED",
          );
        }
        if (asNum(run.error_count) > 0) {
          throw conflict(
            `Run ${run.run_number} has ${asNum(run.error_count)} employee(s) in error; resolve them before approval.`,
            "PAYROLL_RUN_HAS_ERRORS",
          );
        }
      } else if (run.approved_by !== null && run.approved_by === run.computed_by) {
        // Defensive: an approved run that breaks the rule should never exist.
        throw conflict(
          "This run's approval violates the two-person rule and must be investigated.",
          "PAYROLL_TWO_PERSON_VIOLATION",
        );
      }

      // 9d · Job row for observability + a publish-in-progress lock.
      const lockKey = `payslip_publish:${run.id}`;
      const begun = await tx<{ id: string | null }[]>`
        SELECT app.job_begin(${JOB_CODE}, ${lockKey}) AS id
      `;
      let jobRunId = firstRow(begun)?.id ?? null;
      let resumed = false;
      let priorPublished = 0;
      if (jobRunId === null) {
        const running = await tx<{ id: string; result: unknown }[]>`
          SELECT id, result
            FROM public.job_runs
           WHERE lock_key = ${lockKey} AND status = 'running'
           ORDER BY started_at DESC
           LIMIT 1
        `;
        const row = firstRow(running);
        if (row === null) {
          throw conflict(
            "Another publish job just claimed this run. Retry in a moment.",
            "PAYROLL_RUN_IN_PROGRESS",
          );
        }
        jobRunId = row.id;
        resumed = true;
        priorPublished = asNum((row.result as { published?: unknown } | null)?.published);
      } else {
        // A NEW publish job: spend the `heavyJob` token, on the POOL so a
        // rollback cannot refund it (ratelimit.ts).
        await enforce(
          RATE_LIMITS.heavyJob,
          limitKey(FN_NAME, auth.userId, run.id),
          "PAYROLL_RATE_LIMITED",
          pool,
        );
        await tx`
          UPDATE public.job_runs
             SET run_kind = 'manual', triggered_by = ${auth.userId}::uuid
           WHERE id = ${jobRunId}::uuid
        `;
      }

      // 9e · Approve. The 022 trigger re-checks the two-person rule, refuses on
      // any `error` row and demands `app.has_reason()` when |variance| > 10% —
      // `ctx.reason` is already in the session, so an acknowledged variance
      // passes and an unexplained one cannot.
      let approvedNow = false;
      if (!alreadyReleased) {
        await tx`
          UPDATE public.payroll_runs
             SET status      = 'approved',
                 approved_at = now(),
                 approved_by = ${auth.userId}::uuid,
                 reviewed_at = COALESCE(reviewed_at, now()),
                 reviewed_by = COALESCE(reviewed_by, ${auth.userId}::uuid)
           WHERE id = ${run.id}::uuid
        `;
        approvedNow = true;
      }

      // 9f · The batch still needing a PDF. `pdf_document_id IS NULL` is the
      // whole resume mechanism: no cursor to persist, no chance of double
      // publishing, and a re-run after a partial failure picks up exactly the
      // stragglers.
      const pending = await tx<PayslipRow[]>`
        SELECT ps.id,
               ps.employee_id,
               ps.payslip_number,
               ps.period_start::text AS period_start,
               ps.period_end::text   AS period_end,
               ps.pay_date::text     AS pay_date,
               ps.period_days,
               ps.paid_days, ps.lop_days, ps.present_days, ps.weekly_off_days,
               ps.holiday_days, ps.leave_days_paid, ps.leave_days_unpaid,
               ps.overtime_minutes, ps.late_deduction_days,
               ps.gross_earnings_paise, ps.total_deductions_paise, ps.net_pay_paise,
               ps.net_pay_words, ps.employer_contributions_paise,
               ps.ytd_gross_paise, ps.ytd_deductions_paise, ps.ytd_net_paise, ps.ytd_tds_paise,
               ps.payment_mode::text AS payment_mode,
               e.employee_code, e.display_name, e.first_name, e.last_name,
               e.profile_id, e.date_of_join::text AS date_of_join,
               dg.name AS designation_name,
               dp.name AS department_name,
               lo.name AS location_name,
               ba.bank_name, ba.ifsc AS bank_ifsc, ba.account_number AS bank_account_number,
               es.uan, es.pf_number, es.esi_number, es.pan AS employee_pan,
               co.legal_name             AS company_legal_name,
               co.trade_name             AS company_trade_name,
               co.pan                    AS company_pan,
               co.tan                    AS company_tan,
               co.pf_establishment_code  AS company_pf_code,
               co.esi_establishment_code AS company_esi_code,
               co.registered_address     AS company_address
          FROM public.payslips ps
          JOIN public.employees e  ON e.id = ps.employee_id
          JOIN public.companies co ON co.id = e.company_id
          LEFT JOIN public.designations       dg ON dg.id = e.designation_id
          LEFT JOIN public.departments        dp ON dp.id = e.department_id
          LEFT JOIN public.locations          lo ON lo.id = e.location_id
          LEFT JOIN public.employee_bank_accounts ba ON ba.id = ps.bank_account_id
          LEFT JOIN public.employee_statutory es ON es.employee_id = ps.employee_id
         WHERE ps.payroll_run_id = ${run.id}::uuid
           AND ps.pdf_document_id IS NULL
           AND NOT ps.is_reversed
         ORDER BY e.employee_code
         LIMIT ${batchSize}
      `;

      const remainingRows = await tx<{ n: string }[]>`
        SELECT COUNT(*) AS n
          FROM public.payslips ps
         WHERE ps.payroll_run_id = ${run.id}::uuid
           AND ps.pdf_document_id IS NULL
           AND NOT ps.is_reversed
      `;
      const pendingTotal = asNum(firstRow(remainingRows)?.n);

      // `document_types` is seeded (042) and `documents.document_type_id` is NOT
      // NULL, so an absent PAYSLIP type is a deployment fault, not a user error.
      const typeRows = await tx<{ id: string }[]>`
        SELECT id FROM public.document_types
         WHERE code = ${DOCUMENT_TYPE_CODE} AND deleted_at IS NULL
         LIMIT 1
      `;
      const documentTypeId = firstRow(typeRows)?.id ?? null;
      if (documentTypeId === null && pending.length > 0) {
        throw serverError("payslip-doc-type", "Payslip document type is not configured.", {
          code: "DOCUMENT_TYPE_MISSING",
        });
      }

      const financial = run.financial_year !== null && run.financial_year !== ""
        ? run.financial_year
        : financialYear(run.period_end);

      const published: PublishedPayslip[] = [];
      const failures: { payslip_id: string; employee_code: string; detail: string }[] = [];
      let notificationsEnqueued = 0;

      for (const slip of pending) {
        // One SAVEPOINT per payslip. Without it, a single constraint violation
        // (say a duplicate `documents` row from a half-finished earlier attempt)
        // would abort the whole transaction and take the approval and the other
        // 24 PDFs with it.
        await tx.unsafe("SAVEPOINT payslip_item");
        try {
          const lineRows = await tx<LineRow[]>`
            SELECT pl.label,
                   pl.line_kind::text AS line_kind,
                   pl.sequence,
                   pl.full_month_amount_paise,
                   pl.amount_paise,
                   pl.ytd_amount_paise,
                   pl.is_prorated,
                   pl.is_arrear
              FROM public.payslip_lines pl
              LEFT JOIN public.salary_components sc ON sc.id = pl.salary_component_id
             WHERE pl.payslip_id = ${slip.id}::uuid
               -- Component flags decide what prints: a zero line only appears if
               -- its component says so. Ad-hoc lines (no component) always print.
               AND (sc.id IS NULL
                    OR (sc.show_on_payslip
                        AND (sc.show_if_zero OR pl.amount_paise <> 0)))
             ORDER BY pl.sequence, pl.label
          `;
          const lines: PayslipLineInput[] = lineRows.map((l) => ({
            label: l.label,
            line_kind: l.line_kind,
            sequence: l.sequence,
            full_month_amount_paise: asNum(l.full_month_amount_paise),
            amount_paise: asNum(l.amount_paise),
            ytd_amount_paise: asNum(l.ytd_amount_paise),
            is_prorated: l.is_prorated,
            is_arrear: l.is_arrear,
          }));

          const netPaise = asNum(slip.net_pay_paise);
          // Generated once, server-side, exactly as the column comment (022)
          // requires — and reused if a previous attempt already wrote it.
          const words = slip.net_pay_words !== null && slip.net_pay_words !== ""
            ? slip.net_pay_words
            : amountInWordsInr(netPaise);

          const name = slip.display_name ??
            [slip.first_name, slip.last_name].filter((p) => p !== null && p !== "").join(" ");

          const { bytes, pageCount } = await renderPayslipPdf({
            company: {
              legal_name: slip.company_legal_name,
              trade_name: slip.company_trade_name,
              address_lines: addressLines(slip.company_address),
              pan: slip.company_pan,
              tan: slip.company_tan,
              pf_establishment_code: slip.company_pf_code,
              esi_establishment_code: slip.company_esi_code,
            },
            employee: {
              employee_code: slip.employee_code,
              display_name: name === "" ? slip.employee_code : name,
              designation: slip.designation_name,
              department: slip.department_name,
              location: slip.location_name,
              date_of_join: slip.date_of_join,
              payment_mode: slip.payment_mode,
              bank_name: slip.bank_name,
              bank_ifsc: slip.bank_ifsc,
              bank_account_masked: slip.bank_account_number === null
                ? null
                : maskTail(slip.bank_account_number, 4),
              uan: slip.uan,
              pf_number: slip.pf_number,
              esi_number: slip.esi_number,
              pan_masked: slip.employee_pan === null ? null : maskTail(slip.employee_pan, 4),
            },
            payslip: {
              id: slip.id,
              payslip_number: slip.payslip_number,
              run_number: run.run_number,
              period_name: run.period_name,
              period_start: slip.period_start,
              period_end: slip.period_end,
              pay_date: slip.pay_date,
              period_days: slip.period_days,
              paid_days: asNum(slip.paid_days),
              lop_days: asNum(slip.lop_days),
              present_days: asNum(slip.present_days),
              weekly_off_days: asNum(slip.weekly_off_days),
              holiday_days: asNum(slip.holiday_days),
              leave_days_paid: asNum(slip.leave_days_paid),
              leave_days_unpaid: asNum(slip.leave_days_unpaid),
              overtime_minutes: slip.overtime_minutes,
              late_deduction_days: asNum(slip.late_deduction_days),
              gross_earnings_paise: asNum(slip.gross_earnings_paise),
              total_deductions_paise: asNum(slip.total_deductions_paise),
              net_pay_paise: netPaise,
              net_pay_words: words,
              employer_contributions_paise: asNum(slip.employer_contributions_paise),
              ytd_gross_paise: asNum(slip.ytd_gross_paise),
              ytd_deductions_paise: asNum(slip.ytd_deductions_paise),
              ytd_net_paise: asNum(slip.ytd_net_paise),
              ytd_tds_paise: asNum(slip.ytd_tds_paise),
            },
            lines,
            generatedAtIst: istTimestamp(nowIso()).replace("T", " "),
            verifyUrl: `https://hr.thetamarindtree.in/verify/${slip.id}`,
          });

          const fileName = `${pathSegment(slip.payslip_number)}.pdf`;
          // Path shape is fixed by `payslips__own_read` (039): segment 3 MUST be
          // the employee code.
          const storagePath = `${run.company_id}/${pathSegment(financial)}/${
            pathSegment(slip.employee_code)
          }/${fileName}`;
          const checksum = await sha256HexBytes(bytes);

          const upload = await storage.upload(storagePath, bytes, {
            contentType: "application/pdf",
            // Deterministic path + idempotent publish: an object left behind by
            // a rolled-back attempt is overwritten, never duplicated.
            upsert: true,
          });
          if (upload.error !== null) {
            // The upstream message goes to the LOG, never into the thrown message:
            // the `catch` below copies `err.message` into `failures[].detail`, which
            // is part of the response body, and errors.ts rule 2 keeps driver and
            // provider prose out of anything caller-facing.
            log.error("payslip storage upload failed", {
              payslip_id: slip.id,
              path: storagePath,
              err: upload.error.message,
            });
            throw new Error("the payslip PDF could not be stored");
          }

          const docRows = await tx<{ id: string }[]>`
            INSERT INTO public.documents
              (document_type_id, company_id, subject_kind, employee_id, title, file_name,
               storage_bucket, storage_path, mime_type, file_size_bytes, checksum_sha256,
               page_count, status, issue_date, uploaded_by, is_system_generated,
               source_reference, is_confidential, virus_scan_status)
            VALUES (
              ${documentTypeId}::uuid,
              ${run.company_id}::uuid,
              'employee',
              ${slip.employee_id}::uuid,
              ${`Payslip ${slip.payslip_number} — ${run.period_name}`},
              ${fileName},
              ${BUCKET},
              ${storagePath},
              'application/pdf',
              ${bytes.byteLength}::bigint,
              ${checksum},
              ${pageCount}::integer,
              'approved'::public.document_status,
              ${slip.pay_date}::date,
              ${auth.userId}::uuid,
              true,
              ${JSON.stringify({
            payslip_id: slip.id,
            payroll_run_id: run.id,
            run_number: run.run_number,
            pay_period_id: run.pay_period_id,
            generated_by_fn: FN_NAME,
            request_id: requestId,
          })}::jsonb,
              true,
              -- Generated by this function from our own data: there is no
              -- uploaded file to scan, and 'pending' would park it behind a
              -- scanner that will never look at it.
              'skipped'
            )
            RETURNING id
          `;
          const documentId = (firstRow(docRows) as { id: string }).id;

          await tx`
            UPDATE public.payslips
               SET pdf_document_id  = ${documentId}::uuid,
                   pdf_generated_at = now(),
                   net_pay_words    = ${words}
             WHERE id = ${slip.id}::uuid
          `;

          if (shouldNotify) {
            // Enqueue only — `notification-dispatch` (#14) delivers, honouring
            // per-user channel preferences and quiet hours. Two rows per payslip
            // (in_app + email), each linked to its seeded template so the
            // dispatcher can render the email body from `payload`.
            //
            // `title`/`body` are stored ALREADY RENDERED: the in-app feed reads
            // these columns directly, and "Your payslip for {{period_name}} is
            // ready" is not something to show a human.
            //
            // `dedupe_key` makes a re-publish silent instead of spamming. Its
            // unique index is PER PARTITION (see the 027 table comment), so the
            // guard has to be an explicit NOT EXISTS — there is no index on the
            // partitioned parent for `ON CONFLICT` to use.
            const dedupePrefix = `payslip:${slip.id}:${EVENT_CODE}:`;
            const notified = await tx`
              INSERT INTO public.notifications
                (employee_id, profile_id, template_id, event_code, channel, title, body,
                 deep_link, payload, priority, status, dedupe_key)
              SELECT ${slip.employee_id}::uuid,
                     ${slip.profile_id}::uuid,
                     t.id,
                     ${EVENT_CODE},
                     ch.channel::public.notification_channel,
                     'Your payslip is ready',
                     ${`Your payslip for ${run.period_name} is ready to view in the app.`},
                     ${`/me/payslips/${slip.period_start.slice(0, 7)}`},
                     ${JSON.stringify({
              payslip_id: slip.id,
              payslip_number: slip.payslip_number,
              payroll_run_id: run.id,
              period_name: run.period_name,
              pay_date: slip.pay_date,
              document_id: documentId,
              net_pay_words: words,
            })}::jsonb,
                     'normal',
                     'queued'::public.notification_status,
                     ${dedupePrefix} || ch.channel
                FROM (VALUES ('in_app'), ('email')) AS ch(channel)
                LEFT JOIN public.notification_templates t
                       ON t.company_id = ${run.company_id}::uuid
                      AND t.code    = ${EVENT_CODE}
                      AND t.channel = ch.channel::public.notification_channel
                      AND t.is_active
                      AND t.deleted_at IS NULL
               WHERE NOT EXISTS (
                       SELECT 1 FROM public.notifications n
                        WHERE n.dedupe_key = ${dedupePrefix} || ch.channel)
              RETURNING 1
            `;
            // `RETURNING 1` + `.length`, the same shape every other enqueue in the
            // tree uses (see cron-compoff-expiry). The previous `notified.count`
            // was the only place in supabase/functions reaching for postgres.js's
            // `RowList` metadata, which the project's `Sql` alias does not promise.
            notificationsEnqueued += (notified as unknown as unknown[]).length;
          }

          published.push({
            payslip_id: slip.id,
            employee_code: slip.employee_code,
            payslip_number: slip.payslip_number,
            document_id: documentId,
            storage_path: storagePath,
            checksum_sha256: checksum,
            size_bytes: bytes.byteLength,
            page_count: pageCount,
            net_paise: netPaise,
          });
          await tx.unsafe("RELEASE SAVEPOINT payslip_item");
        } catch (err) {
          // Rewind just this payslip. The approval and the PDFs already written
          // in this transaction survive; the object possibly left in the bucket
          // is overwritten by the next attempt (deterministic path + upsert).
          await tx.unsafe("ROLLBACK TO SAVEPOINT payslip_item");
          await tx.unsafe("RELEASE SAVEPOINT payslip_item");
          if (isProblem(err)) throw err;
          const detail = (err instanceof Error ? err.message : String(err)).slice(0, 500);
          failures.push({
            payslip_id: slip.id,
            employee_code: slip.employee_code,
            detail,
          });
          log.warn("payslip render failed", {
            payslip_id: slip.id,
            employee_code: slip.employee_code,
            err,
          });
        }
      }

      const remaining = Math.max(0, pendingTotal - published.length);
      const done = remaining === 0;
      const totalPublished = priorPublished + published.length;

      // 9g · Close or park the job.
      const jobResult = {
        payroll_run_id: run.id,
        run_number: run.run_number,
        published: totalPublished,
        failed: failures.length,
        remaining,
        done,
        approved_now: approvedNow,
      };
      if (done && failures.length === 0) {
        await tx`
          SELECT app.job_end(${jobRunId}::uuid, 'succeeded'::public.job_run_status,
                             ${totalPublished}::integer, 0::integer,
                             ${JSON.stringify(jobResult)}::jsonb, NULL)
        `;
        // ── STEP 10 · Audit, same transaction ─────────────────────────────
        // The row changes (payroll_runs approval, payslips, documents) are
        // already hash-chained by `audit.log_changes()` — audit.ts is explicit
        // that those must not be double-logged. `public.job_runs` is NOT
        // trigger-audited, so this is the one row that records the publish as an
        // EVENT with its outcome.
        await auditJobRun(tx, ctx, {
          jobCode: JOB_CODE,
          runId: jobRunId,
          outcome: "succeeded",
          stats: jobResult,
        });
      } else if (done) {
        await tx`
          SELECT app.job_end(${jobRunId}::uuid, 'failed'::public.job_run_status,
                             ${totalPublished}::integer, ${failures.length}::integer,
                             ${JSON.stringify(jobResult)}::jsonb,
                             ${`${failures.length} payslip(s) could not be rendered`}::text)
        `;
        await auditJobRun(tx, ctx, {
          jobCode: JOB_CODE,
          runId: jobRunId,
          outcome: "failed",
          stats: jobResult,
        });
      } else {
        await tx`
          UPDATE public.job_runs
             SET result            = ${JSON.stringify(jobResult)}::jsonb,
                 records_processed = ${totalPublished}::integer,
                 records_failed    = ${failures.length}::integer
           WHERE id = ${jobRunId}::uuid
        `;
      }

      return {
        run,
        jobRunId,
        resumed,
        approvedNow,
        published,
        failures,
        remaining,
        done,
        totalPublished,
        notificationsEnqueued,
      };
    }).catch(mapPgError);

    const afterRows = await pool<
      { status: string; approved_at: Date | null; approved_by: string | null }[]
    >`
      SELECT status::text AS status, approved_at, approved_by
        FROM public.payroll_runs
       WHERE id = ${body.payroll_run_id}::uuid
    `;
    const after = firstRow(afterRows);

    const finalStatus = after?.status ?? outcome.run.status;
    const responseBody = {
      payroll_run_id: outcome.run.id,
      run_number: outcome.run.run_number,
      status: finalStatus,
      /** What `public.payroll_run_is_released()` says: payslips are now visible. */
      released: ["approved", "disbursement_pending", "paid", "closed"].includes(finalStatus),
      approval: {
        approved_now: outcome.approvedNow,
        approved_at: after?.approved_at ?? outcome.run.approved_at,
        approved_by: after?.approved_by ?? outcome.run.approved_by,
        prepared_by: outcome.run.computed_by,
        two_person_satisfied: outcome.run.computed_by !== null &&
          outcome.run.computed_by !== (after?.approved_by ?? outcome.run.approved_by),
        /** Signed delta vs the previous released regular run; outside [0,100] is valid. */
        variance_vs_previous_pct: asNumOrNull(outcome.run.variance_vs_previous_pct),
        net_total_paise: asNum(outcome.run.total_net_paise),
      },
      pay_period: {
        id: outcome.run.pay_period_id,
        name: outcome.run.period_name,
        start_date: outcome.run.period_start,
        end_date: outcome.run.period_end,
        financial_year: outcome.run.financial_year,
      },
      job_run_id: outcome.jobRunId,
      resumed: outcome.resumed,
      done: outcome.done,
      payslips: {
        published_this_call: outcome.published.length,
        published_total: outcome.totalPublished,
        remaining: outcome.remaining,
        batch_size: batchSize,
        items: outcome.published,
      },
      notifications_enqueued: outcome.notificationsEnqueued,
      failures: outcome.failures,
      server_time: nowIso(),
      requestId,
    };
    status = 200;

    // ── STEP 11 · Store the response under the idempotency key ─────────────
    await store(idempotencyKey, status, responseBody, pool);

    log.info("payslips published", {
      payroll_run_id: outcome.run.id,
      job_run_id: outcome.jobRunId,
      approved_now: outcome.approvedNow,
      published: outcome.published.length,
      remaining: outcome.remaining,
      failed: outcome.failures.length,
      done: outcome.done,
    });

    return ok(responseBody, { status, headers: cors, requestId });
  } catch (err) {
    const problem = toProblem(err, requestId).withContext({ requestId, instance });
    status = problem.status;

    if (idempotencyKey !== null) {
      try {
        if (status >= 500) await release(idempotencyKey);
        else await store(idempotencyKey, status, problem.problem);
      } catch (storeErr) {
        log.warn("could not finalise idempotency key", { key: idempotencyKey, err: storeErr });
      }
    }

    if (problem.isServerFault) log.error("unhandled failure", { err, code: problem.code });
    else log.warn("request refused", { code: problem.code, status });
    return problem.toResponse(cors);
  } finally {
    // ── STEP 12 · One structured log line per invocation ────────────────────
    log.finish(status, { idempotency_key: idempotencyKey });
  }
});

/** Exported for `supabase/tests` and the admin client — one schema, one contract. */
export { pathSegment, PublishBody };
