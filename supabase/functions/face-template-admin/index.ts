/**
 * face-template-admin — catalogue #6, auth model **U+** (`biometric.template.manage`),
 * with `purge` additionally gated on super_admin + `biometric.template.purge`.
 *
 * The lifecycle of a face template after `face-enrol` has parked it as pending:
 *
 *   list          metadata only — NEVER a descriptor, on any code path
 *   approve       activate the set's matchable row, retire the previous version,
 *                 stamp `employees.face_enrolled_at`
 *   deactivate    retire a version (also the way a pending enrolment is rejected)
 *   force_reenrol retire everything the employee has, so the kiosk stops matching
 *                 them and the enrolment-gap alert picks them up
 *   purge         DPDP Act 2023 erasure: zero the descriptor in the template AND in
 *                 the archive, drop the capture objects, keep the row as evidence
 *
 * WHY THIS FUNCTION NEVER RETURNS A DESCRIPTOR. `secure` is off PostgREST (boundary
 * B6) and `secure.face_templates.descriptor` is `omit`-redacted in
 * `audit.redacted_columns`, so the only way a 128-D face embedding could ever reach a
 * browser is an edge function choosing to send it. This one does not: every SELECT
 * below lists its columns explicitly and `descriptor` is not among them. Reviewers
 * get quality numbers, distances and — with a reason, audited per employee — a
 * short-lived signed URL to the reference photo.
 *
 * TEMPLATE SETS. `face-enrol` writes one row per accepted capture, all sharing one
 * `version`, and nominates the medoid via
 * `public.face_enrolment_requests.resulting_template_id`. Everything here therefore
 * operates on the SET (`employee_id` + `version`), not on a lone row: approving,
 * retiring or purging half a set would leave descriptors of the same face in a
 * different state from their siblings.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import {
  conflict,
  forbidden,
  gone,
  methodNotAllowed,
  notFound,
  ok,
  toProblem,
  unprocessable,
} from "../_shared/errors.ts";
import { common, parseBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { toIso } from "../_shared/datetime.ts";
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
import { type AuthContext, requireCapWithStepUp, requireRole, verifyUser } from "../_shared/auth.ts";
import { enforce, limitKey, RATE_LIMITS } from "../_shared/ratelimit.ts";
import {
  claim,
  release,
  replayResponse,
  requestHash,
  requireIdempotencyKey,
  store,
} from "../_shared/idempotency.ts";
import { auditDataAccess, writeAudit } from "../_shared/audit.ts";

const FN_NAME = "face-template-admin";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

const CAPTURE_BUCKET = "face-enrolment-captures";
const MANAGE_CAP = "biometric.template.manage";
const PURGE_CAP = "biometric.template.purge";

/** Signed-URL ceiling for a biometric capture (spec-admin §12: face captures 60 s). */
const CAPTURE_URL_TTL_SECONDS = 60;
const MAX_CAPTURE_URLS = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Request schema
// ─────────────────────────────────────────────────────────────────────────────

const ListOp = z
  .object({
    op: z.literal("list"),
    employee_id: common.uuid.optional(),
    employee_code: common.employeeCode.optional(),
    /** Default `pending`: this endpoint's main job is the review queue. */
    state: z.enum(["all", "pending", "active", "inactive", "purged"]).default("pending"),
    /** Signs the reference photos. Audited per employee, needs a reason. */
    include_capture_urls: z.boolean().default(false),
    reason: common.reason.optional(),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).max(100_000).default(0),
  })
  .strict();

const ApproveOp = z
  .object({
    op: z.literal("approve"),
    template_id: common.uuid,
    /** `public.employees` is in `audit.reason_required_tables`; ≥10 chars or the txn aborts. */
    reason: common.reason,
    comment: z.string().trim().max(1_000).optional(),
  })
  .strict();

const DeactivateOp = z
  .object({
    op: z.literal("deactivate"),
    template_id: common.uuid,
    reason: common.reason,
  })
  .strict();

const ForceReenrolOp = z
  .object({
    op: z.literal("force_reenrol"),
    employee_id: common.uuid,
    reason: common.reason,
  })
  .strict();

const PurgeOp = z
  .object({
    op: z.literal("purge"),
    /** `template` purges the whole version the row belongs to; `employee` purges all. */
    scope: z.enum(["template", "employee"]),
    template_id: common.uuid.optional(),
    employee_id: common.uuid.optional(),
    /** Irreversible: 20 characters, and the incident/DPDP request should be named. */
    reason: z.string().trim().min(20, "Give a reason of at least 20 characters, naming the request or incident."),
    /** Typed confirmation (T-19): must equal the employee's code, exactly. */
    confirm_employee_code: common.employeeCode,
  })
  .strict();

const AdminBody = z.discriminatedUnion("op", [ListOp, ApproveOp, DeactivateOp, ForceReenrolOp, PurgeOp]);

type AdminInput = z.infer<typeof AdminBody>;

// ─────────────────────────────────────────────────────────────────────────────
// Row shapes (postgres.js: `numeric` → string, `timestamptz` → Date)
// ─────────────────────────────────────────────────────────────────────────────

interface TemplateListRow {
  id: string;
  employee_id: string;
  employee_code: string;
  display_name: string | null;
  employment_status: string;
  version: number;
  is_active: boolean;
  is_representative: boolean | null;
  sample_count: number;
  descriptor_dim: number;
  quality_score: string;
  intra_sample_max_distance: string;
  model_name: string;
  model_version: string;
  detector: string;
  yaw: string | null;
  pitch: string | null;
  roll: string | null;
  brightness: string | null;
  blur_score: string | null;
  enrolled_at: Date | string;
  enrolled_by: string | null;
  enrolled_by_name: string | null;
  enrolled_device_code: string | null;
  approved_at: Date | string | null;
  approved_by: string | null;
  approved_by_name: string | null;
  deactivated_at: Date | string | null;
  deactivation_reason: string | null;
  purged_at: Date | string | null;
  enrolment_photo_path: string | null;
  consent_version: string | null;
  consent_granted_at: Date | string | null;
  consent_withdrawn_at: Date | string | null;
  request_id: string | null;
  request_status: string | null;
  requested_at: Date | string | null;
  requested_via: string | null;
  review_comment: string | null;
  /** `count(*) OVER ()` is a bigint — postgres.js hydrates it as a string. */
  total_count: string | number;
}

interface TargetRow {
  id: string;
  employee_id: string;
  employee_code: string;
  display_name: string | null;
  version: number;
  is_active: boolean;
  approved_at: Date | string | null;
  deactivated_at: Date | string | null;
  purged_at: Date | string | null;
  sample_count: number;
  quality_score: string;
  model_version: string;
  in_scope: boolean;
  request_id: string | null;
  request_status: string | null;
}

const num = (value: string | null): number | null => (value === null ? null : Number(value));
const iso = (value: Date | string | null): string | null => (value === null ? null : toIso(value));

/** Quality band — the employee-facing vocabulary (spec-employee §): never a number. */
function qualityBand(score: number): "good" | "fair" | "poor" {
  return score >= 0.8 ? "good" : score >= 0.55 ? "fair" : "poor";
}

function templateState(row: {
  is_active: boolean;
  approved_at: Date | string | null;
  deactivated_at: Date | string | null;
  purged_at: Date | string | null;
}): "active" | "pending_approval" | "inactive" | "purged" {
  if (row.purged_at !== null) return "purged";
  if (row.is_active) return "active";
  if (row.deactivated_at !== null) return "inactive";
  return row.approved_at === null ? "pending_approval" : "inactive";
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

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
    const pool = sql();

    // ── STEP 4 · Auth (model U) ──────────────────────────────────────────────
    const auth: AuthContext = await verifyUser(req);

    // ── STEP 5 · Authority (model U+) ────────────────────────────────────────
    // `biometric.template.manage` carries `requires_step_up = true` in migration
    // 050, so this single call demands the capability AND a fresh aal2. Purge adds
    // its own super-admin-only capability below, once the op is known.
    await requireCapWithStepUp(pool, auth, MANAGE_CAP);

    // ── STEP 7 · Validate (before the rate limit key can depend on the op) ───
    const { data: body, raw } = await parseBody(req, AdminBody, { maxBytes: 16 * 1024 });
    const input: AdminInput = body;

    // ── STEP 6 · Rate limit ──────────────────────────────────────────────────
    const spec = input.op === "purge"
      ? RATE_LIMITS.heavyJob
      : input.op === "list" && input.include_capture_urls
      ? RATE_LIMITS.reveal
      : RATE_LIMITS.mutation;
    await enforce(spec, limitKey(FN_NAME, input.op, auth.userId));

    const ctx: RequestContext = {
      actorId: auth.userId,
      actorRole: auth.role,
      source: "web_admin",
      sourceRoute: FN_NAME,
      requestId,
      ip: clientIpFrom(req),
      ua: userAgentFrom(req),
      reason: input.op === "list" ? (input.reason ?? null) : input.reason,
    };

    // ═══════════════════════════════════════════════════════════════════════
    // op = list — metadata only
    // ═══════════════════════════════════════════════════════════════════════
    if (input.op === "list") {
      if (input.include_capture_urls && (input.reason === undefined)) {
        throw unprocessable(
          [{
            pointer: "/reason",
            code: "required",
            detail: "Signing a biometric capture is an audited reveal; give a reason of at least 10 characters.",
          }],
          "A reason is required to view enrolment photos.",
          "REASON_REQUIRED",
        );
      }

      const state = input.state;
      // Read inside a context transaction. `app.admin_scope_covers()` resolves the
      // caller through `app.ctx_actor_id()`, and `set_config(…, true)` lives only for
      // the life of a transaction — run on the pool the actor would be NULL and this
      // listing would return nothing at all for every non-super-admin.
      const rows = await withContext(ctx, async (tx) =>
        await tx<TemplateListRow[]>`
        SELECT t.id,
               t.employee_id,
               e.employee_code,
               e.display_name,
               e.employment_status::text          AS employment_status,
               t.version,
               t.is_active,
               (r.resulting_template_id = t.id)   AS is_representative,
               t.sample_count,
               t.descriptor_dim,
               t.quality_score,
               t.intra_sample_max_distance,
               t.model_name,
               t.model_version,
               t.detector,
               t.yaw, t.pitch, t.roll, t.brightness, t.blur_score,
               t.enrolled_at,
               t.enrolled_by,
               eb.full_name                       AS enrolled_by_name,
               kd.device_code                     AS enrolled_device_code,
               t.approved_at,
               t.approved_by,
               ap.full_name                       AS approved_by_name,
               t.deactivated_at,
               t.deactivation_reason,
               t.purged_at,
               t.enrolment_photo_path,
               bc.consent_version,
               bc.granted_at                      AS consent_granted_at,
               bc.withdrawn_at                    AS consent_withdrawn_at,
               r.id                               AS request_id,
               r.status::text                     AS request_status,
               r.requested_at,
               r.requested_via,
               r.review_comment,
               count(*) OVER ()                   AS total_count
          FROM secure.face_templates t
          JOIN public.employees e
            ON e.id = t.employee_id AND e.deleted_at IS NULL
          LEFT JOIN public.profiles eb ON eb.id = t.enrolled_by
          LEFT JOIN public.profiles ap ON ap.id = t.approved_by
          LEFT JOIN public.kiosk_devices kd ON kd.id = t.enrolled_device_id
          LEFT JOIN secure.biometric_consents bc ON bc.id = t.consent_id
          LEFT JOIN LATERAL (
            SELECT fr.id, fr.status, fr.requested_at, fr.requested_via,
                   fr.review_comment, fr.resulting_template_id
              FROM public.face_enrolment_requests fr
             WHERE fr.resulting_template_id = t.id
             ORDER BY fr.requested_at DESC
             LIMIT 1
          ) r ON true
         WHERE app.admin_scope_covers(t.employee_id)
           AND (${input.employee_id ?? null}::uuid IS NULL OR t.employee_id = ${input.employee_id ?? null}::uuid)
           AND (${input.employee_code ?? null}::text IS NULL OR e.employee_code = ${input.employee_code ?? null}::text)
           AND (
             ${state}::text = 'all'
             OR (${state}::text = 'pending'  AND t.approved_at IS NULL AND t.deactivated_at IS NULL AND t.purged_at IS NULL)
             OR (${state}::text = 'active'   AND t.is_active)
             OR (${state}::text = 'inactive' AND t.deactivated_at IS NOT NULL AND t.purged_at IS NULL)
             OR (${state}::text = 'purged'   AND t.purged_at IS NOT NULL)
           )
         ORDER BY t.enrolled_at DESC, t.version DESC, t.id
         LIMIT ${input.limit}::integer OFFSET ${input.offset}::integer
      `
      );

      // Signed capture URLs. The signing itself is HTTP, so it happens between the
      // read and the audit transaction rather than inside either.
      const captureUrls = new Map<string, string>();
      const revealedSubjects: { employeeId: string; templateId: string }[] = [];
      if (input.include_capture_urls) {
        const storage = serviceClient().storage.from(CAPTURE_BUCKET);
        const seenSubjects = new Set<string>();
        let signed = 0;
        for (const row of rows) {
          if (row.enrolment_photo_path === null || row.purged_at !== null) continue;
          if (signed >= MAX_CAPTURE_URLS) break;
          const { data, error } = await storage.createSignedUrl(
            row.enrolment_photo_path,
            CAPTURE_URL_TTL_SECONDS,
          );
          if (error !== null || data === null) {
            log.warn("could not sign enrolment capture", { template_id: row.id });
            continue;
          }
          captureUrls.set(row.id, data.signedUrl);
          signed++;
          if (!seenSubjects.has(row.employee_id)) {
            seenSubjects.add(row.employee_id);
            revealedSubjects.push({ employeeId: row.employee_id, templateId: row.id });
          }
        }
      }

      const total = rows.length > 0 ? Number(rows[0]?.total_count ?? rows.length) : 0;
      const templates = rows.map((row) => {
        const quality = Number(row.quality_score);
        return {
          templateId: row.id,
          employeeId: row.employee_id,
          employeeCode: row.employee_code,
          displayName: row.display_name,
          employmentStatus: row.employment_status,
          version: row.version,
          state: templateState(row),
          isActive: row.is_active,
          isRepresentative: row.is_representative === true,
          sampleCount: row.sample_count,
          descriptorDim: row.descriptor_dim,
          qualityScore: quality,
          qualityBand: qualityBand(quality),
          intraSampleMaxDistance: Number(row.intra_sample_max_distance),
          pose: {
            yaw: num(row.yaw),
            pitch: num(row.pitch),
            roll: num(row.roll),
            brightness: num(row.brightness),
            /** Normalised sharpness (0.5 = at the enrol threshold), not a raw variance. */
            blurScore: num(row.blur_score),
          },
          model: { name: row.model_name, version: row.model_version, detector: row.detector },
          enrolledAt: iso(row.enrolled_at),
          enrolledBy: row.enrolled_by,
          enrolledByName: row.enrolled_by_name,
          enrolledDeviceCode: row.enrolled_device_code,
          approvedAt: iso(row.approved_at),
          approvedBy: row.approved_by,
          approvedByName: row.approved_by_name,
          deactivatedAt: iso(row.deactivated_at),
          deactivationReason: row.deactivation_reason,
          purgedAt: iso(row.purged_at),
          consent: {
            version: row.consent_version,
            grantedAt: iso(row.consent_granted_at),
            withdrawnAt: iso(row.consent_withdrawn_at),
          },
          enrolmentRequest: row.request_id === null ? null : {
            id: row.request_id,
            status: row.request_status,
            requestedAt: iso(row.requested_at),
            requestedVia: row.requested_via,
            reviewComment: row.review_comment,
          },
          /** Present only when `include_capture_urls` was asked for and audited. */
          captureUrl: captureUrls.get(row.id) ?? null,
          captureUrlExpiresInSeconds: captureUrls.has(row.id) ? CAPTURE_URL_TTL_SECONDS : null,
          // `descriptor` is deliberately absent. Do not add it.
        };
      });

      // Access log, one transaction: a `bulk_view` row for the listing itself
      // (spec-admin §12 audits every `face_template` read) plus ONE `reveal` row per
      // SUBJECT whose photo was signed (§6: "bulk reveal writes one row per
      // employee"). Written after the URLs exist, so a signing failure cannot leave
      // an audit row claiming a reveal that never happened.
      if (templates.length > 0) {
        await withContext(ctx, async (tx) => {
          await auditDataAccess(tx, ctx, {
            accessKind: "bulk_view",
            entityTable: "secure.face_templates",
            subjectEmployeeId: templates.length === 1 ? templates[0]?.employeeId ?? null : null,
            fields: ["quality_score", "intra_sample_max_distance", "version", "model_version"],
            purpose: input.reason ?? "Biometric template metadata review in the enrolment console",
            recordCount: templates.length,
            filterSummary: {
              state,
              employee_id: input.employee_id ?? null,
              employee_code: input.employee_code ?? null,
              limit: input.limit,
              offset: input.offset,
            },
          });
          for (const subject of revealedSubjects) {
            await auditDataAccess(tx, ctx, {
              accessKind: "reveal",
              entityTable: "secure.face_templates",
              entityId: subject.templateId,
              subjectEmployeeId: subject.employeeId,
              fields: ["enrolment_photo_path"],
              purpose: input.reason ?? "Biometric enrolment photo review",
              recordCount: 1,
              filterSummary: { ttl_seconds: CAPTURE_URL_TTL_SECONDS, state },
            });
          }
        });
      }

      status = 200;
      const listBody = {
        op: "list" as const,
        state,
        total,
        limit: input.limit,
        offset: input.offset,
        templates,
        requestId,
      };
      log.info("templates listed", { state, returned: templates.length, total });
      return ok(listBody, { status, headers: cors, requestId });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Mutations
    // ═══════════════════════════════════════════════════════════════════════

    if (input.op === "purge") {
      // Purge is irreversible and is the one action `admin` must never hold.
      // `biometric.template.purge` is seeded super_admin-only with
      // `requires_step_up = true`; the role check is belt-and-braces on top.
      requireRole(auth, "super_admin");
      await requireCapWithStepUp(pool, auth, PURGE_CAP);
      if (input.scope === "template" && input.template_id === undefined) {
        throw unprocessable(
          [{ pointer: "/template_id", code: "required", detail: "template_id is required when scope is template." }],
          "Nothing to purge.",
          "VALIDATION_FAILED",
        );
      }
      if (input.scope === "employee" && input.employee_id === undefined) {
        throw unprocessable(
          [{ pointer: "/employee_id", code: "required", detail: "employee_id is required when scope is employee." }],
          "Nothing to purge.",
          "VALIDATION_FAILED",
        );
      }
    }

    // ── STEP 8 · Idempotency claim ───────────────────────────────────────────
    idempotencyKey = requireIdempotencyKey(req);
    const hash = await requestHash(FN_NAME, raw, auth.userId);
    const claimed = await claim({
      key: idempotencyKey,
      fnName: FN_NAME,
      requestHash: hash,
      actorId: auth.userId,
    });
    if (claimed.state === "replay") {
      status = claimed.status;
      log.info("idempotent replay", { key: idempotencyKey, op: input.op });
      return replayResponse(claimed, { ...cors, "x-request-id": requestId });
    }

    // Resolve the target (template or employee) with scope enforced. 404 covers
    // both "absent" and "outside your admin scope".
    //
    // In a context transaction for the same reason as the listing above:
    // `app.admin_scope_covers()` needs `app.actor_id`, which is transaction-scoped.
    // The write transactions that follow re-assert every precondition in their WHERE
    // clauses, so a concurrent change between the two produces zero updated rows
    // rather than a wrong write.
    let target: TargetRow | null = null;
    if (input.op === "approve" || input.op === "deactivate" ||
      (input.op === "purge" && input.scope === "template")) {
      const templateId = input.op === "purge" ? (input.template_id as string) : input.template_id;
      const rows = await withContext(ctx, async (tx) =>
        await tx<TargetRow[]>`
        SELECT t.id,
               t.employee_id,
               e.employee_code,
               e.display_name,
               t.version,
               t.is_active,
               t.approved_at,
               t.deactivated_at,
               t.purged_at,
               t.sample_count,
               t.quality_score,
               t.model_version,
               app.admin_scope_covers(t.employee_id) AS in_scope,
               r.id                                  AS request_id,
               r.status::text                        AS request_status
          FROM secure.face_templates t
          JOIN public.employees e ON e.id = t.employee_id AND e.deleted_at IS NULL
          LEFT JOIN LATERAL (
            SELECT fr.id, fr.status
              FROM public.face_enrolment_requests fr
             WHERE fr.resulting_template_id = t.id
             ORDER BY fr.requested_at DESC
             LIMIT 1
          ) r ON true
         WHERE t.id = ${templateId}::uuid
         LIMIT 1
      `
      );
      target = firstRow(rows);
      if (target === null || target.in_scope !== true) {
        throw notFound("No such face template.", "FACE_TEMPLATE_NOT_FOUND");
      }
    }

    // ── STEP 9/10 · app.set_context + ONE transaction (+ audit inside it) ────

    if (input.op === "approve") {
      const t = target as TargetRow;
      if (t.purged_at !== null) {
        throw gone("This template has been purged and cannot be approved.", "FACE_TEMPLATE_PURGED");
      }
      if (t.deactivated_at !== null) {
        throw conflict("This template has been retired. Enrol again.", "FACE_TEMPLATE_INACTIVE");
      }
      if (t.approved_at !== null) {
        throw conflict("This template has already been approved.", "FACE_TEMPLATE_ALREADY_APPROVED");
      }

      const result = await withContext(ctx, async (tx) => {
        // 1. Retire whatever is currently matching for this employee. Must happen
        //    BEFORE the activation below: `uq_face_templates__employee_active`
        //    permits exactly one active row per employee.
        const retired = await tx<{ id: string; version: number }[]>`
          UPDATE secure.face_templates
             SET is_active           = false,
                 deactivated_at      = now(),
                 deactivation_reason = ${`superseded by v${t.version}: ${input.reason}`}
           WHERE employee_id = ${t.employee_id}::uuid
             AND is_active
             AND id <> ${t.id}::uuid
          RETURNING id, version
        `;

        // 2. Approve the whole SET of this version; only the nominated row becomes
        //    matchable. The siblings stay as retained samples — they are what a
        //    future model upgrade re-derives the template from.
        const approved = await tx<{ id: string; is_active: boolean }[]>`
          UPDATE secure.face_templates
             SET approved_by = ${auth.userId}::uuid,
                 approved_at = now(),
                 is_active   = (id = ${t.id}::uuid)
           WHERE employee_id = ${t.employee_id}::uuid
             AND version     = ${t.version}::integer
             AND purged_at IS NULL
             AND deactivated_at IS NULL
          RETURNING id, is_active
        `;

        // 3. Close the review-queue row and keep its pointer truthful.
        await tx`
          UPDATE public.face_enrolment_requests
             SET status                = 'approved'::public.approval_status,
                 reviewed_by           = ${auth.userId}::uuid,
                 reviewed_at           = now(),
                 review_comment        = ${input.comment ?? input.reason}::text,
                 resulting_template_id = ${t.id}::uuid
           WHERE employee_id = ${t.employee_id}::uuid
             AND status = 'pending'::public.approval_status
        `;

        // 4. The employee is enrolled from this moment, not from capture time.
        //    `public.employees` is reason-required — `ctx.reason` carries it.
        await tx`
          UPDATE public.employees
             SET face_enrolled_at = now()
           WHERE id = ${t.employee_id}::uuid
             AND deleted_at IS NULL
        `;

        /*
          ── 5. APPROVAL TURNS THE PERSON ON EVERYWHERE, NOT JUST AT THE GATE ────
          Asked for directly: once a face is enrolled it should work everywhere, rather than
          leaving somebody enrolled and still refused when they try to punch from the portal.

          APPROVAL is the right moment for it, not capture. An enrolment lands
          `pending_approval` and its template is not `is_active` until this transaction runs —
          which is exactly why face SIGN-IN does not work for a new joiner either, though
          `allow_face_login` has defaulted true all along. Granting anything at capture time
          would hand portal punching to a face nobody had vetted yet, which is the one thing
          this review queue exists to prevent.

          WEB PUNCH is the only switch that needed touching. `employees.allow_web_punch` defaults
          FALSE by design, so every new joiner was enrolled, approved, and then quietly refused
          with SELF_PUNCH_NOT_ENTITLED until an admin found the checkbox in the employee editor.

          Behind a setting, because this widens where attendance can be recorded from — a web
          punch can come from anywhere and the geofence flags it rather than refusing it.
          `attendance.web_punch_on_enrolment` defaults true, which is what was asked for; a venue
          that wants the gate camera to be the only route sets it false, with no deploy.

          It only ever GRANTS. An admin who has deliberately revoked somebody's web punch must
          not have that undone by a re-enrolment, so the UPDATE is conditioned on it being off.
        */
        const webPunchSetting = await tx<{ value: string | null }[]>`
          SELECT app.setting('attendance.web_punch_on_enrolment') AS value
        `;
        const rawSetting = firstRow(webPunchSetting)?.value;
        const grantWebPunch = rawSetting === null || rawSetting === undefined
          ? true
          : !/^"?(false|0|off|no)"?$/i.test(String(rawSetting).trim());

        let webPunchGranted = false;
        if (grantWebPunch) {
          const granted = await tx<{ id: string }[]>`
            UPDATE public.employees
               SET allow_web_punch = true
             WHERE id = ${t.employee_id}::uuid
               AND deleted_at IS NULL
               AND allow_web_punch = false
            RETURNING id
          `;
          webPunchGranted = granted.length > 0;
        }

        await writeAudit(tx, ctx, {
          action: "approve",
          entityTable: "secure.face_templates",
          entityId: t.id,
          entityLabel: `${t.employee_code} face template v${t.version} activated`,
          subjectEmployeeId: t.employee_id,
          newValue: {
            version: t.version,
            state: "active",
            // A permission changed as a side effect of this approval, so the audit row says so.
            web_punch_granted: webPunchGranted,
            approved_set_size: approved.length,
            retired_template_ids: retired.map((r) => r.id),
            quality_score: Number(t.quality_score),
            model_version: t.model_version,
          },
          reason: input.reason,
        });

        return { approvedCount: approved.length, retired };
      });

      status = 200;
      const responseBody = {
        op: "approve" as const,
        templateId: t.id,
        employeeId: t.employee_id,
        employeeCode: t.employee_code,
        displayName: t.display_name,
        version: t.version,
        state: "active" as const,
        approvedSampleCount: result.approvedCount,
        retiredTemplates: result.retired.map((r) => ({ templateId: r.id, version: r.version })),
        faceEnrolledAtSet: true,
        requestId,
      };
      await store(idempotencyKey, status, responseBody);
      log.info("template approved", { template_id: t.id, employee_id: t.employee_id, version: t.version });
      return ok(responseBody, { status, headers: cors, requestId });
    }

    if (input.op === "deactivate") {
      const t = target as TargetRow;
      if (t.purged_at !== null) {
        throw gone("This template has already been purged.", "FACE_TEMPLATE_PURGED");
      }
      if (t.deactivated_at !== null) {
        throw conflict("This template is already retired.", "FACE_TEMPLATE_INACTIVE");
      }
      const wasPending = t.approved_at === null;

      const result = await withContext(ctx, async (tx) => {
        // Retire the whole version: half a retired set would leave live descriptors
        // of a face the reviewer just rejected.
        const retired = await tx<{ id: string; is_active: boolean }[]>`
          UPDATE secure.face_templates
             SET is_active           = false,
                 deactivated_at      = now(),
                 deactivation_reason = ${input.reason}
           WHERE employee_id = ${t.employee_id}::uuid
             AND version     = ${t.version}::integer
             AND deactivated_at IS NULL
             AND purged_at IS NULL
          RETURNING id, is_active
        `;

        // A pending set that is retired IS a rejected enrolment.
        await tx`
          UPDATE public.face_enrolment_requests
             SET status         = ${wasPending ? "rejected" : "cancelled"}::public.approval_status,
                 reviewed_by    = ${auth.userId}::uuid,
                 reviewed_at    = now(),
                 review_comment = ${input.reason}::text
           WHERE employee_id = ${t.employee_id}::uuid
             AND status = 'pending'::public.approval_status
             AND resulting_template_id IN (
               SELECT ft.id FROM secure.face_templates ft
                WHERE ft.employee_id = ${t.employee_id}::uuid
                  AND ft.version = ${t.version}::integer
             )
        `;

        // No active template left ⇒ the employee is not face-enrolled. The
        // `biometric_unenrolled` gap alert keys on exactly this.
        const remaining = await tx<{ still_active: number }[]>`
          SELECT count(*)::integer AS still_active
            FROM secure.face_templates t
           WHERE t.employee_id = ${t.employee_id}::uuid AND t.is_active
        `;
        const stillActive = Number(firstRow(remaining)?.still_active ?? 0);
        if (stillActive === 0) {
          await tx`
            UPDATE public.employees
               SET face_enrolled_at = NULL
             WHERE id = ${t.employee_id}::uuid
               AND deleted_at IS NULL
               AND face_enrolled_at IS NOT NULL
          `;
        }

        await writeAudit(tx, ctx, {
          action: wasPending ? "reject" : "update",
          entityTable: "secure.face_templates",
          entityId: t.id,
          entityLabel: `${t.employee_code} face template v${t.version} ${wasPending ? "rejected" : "retired"}`,
          subjectEmployeeId: t.employee_id,
          oldValue: { state: wasPending ? "pending_approval" : "active" },
          newValue: {
            state: "inactive",
            version: t.version,
            retired_template_ids: retired.map((r) => r.id),
            employee_still_enrolled: stillActive > 0,
          },
          reason: input.reason,
        });

        return { retired, stillActive };
      });

      status = 200;
      const responseBody = {
        op: "deactivate" as const,
        templateId: t.id,
        employeeId: t.employee_id,
        employeeCode: t.employee_code,
        version: t.version,
        state: "inactive" as const,
        wasPending,
        retiredTemplateIds: result.retired.map((r) => r.id),
        employeeStillEnrolled: result.stillActive > 0,
        requestId,
      };
      await store(idempotencyKey, status, responseBody);
      log.info("template retired", { template_id: t.id, was_pending: wasPending });
      return ok(responseBody, { status, headers: cors, requestId });
    }

    if (input.op === "force_reenrol") {
      const employeeRows = await withContext(ctx, async (tx) =>
        await tx<{
          id: string;
          employee_code: string;
          display_name: string | null;
          in_scope: boolean;
        }[]>`
          SELECT e.id, e.employee_code, e.display_name,
                 app.admin_scope_covers(e.id) AS in_scope
            FROM public.employees e
           WHERE e.id = ${input.employee_id}::uuid AND e.deleted_at IS NULL
           LIMIT 1
        `
      );
      const employee = firstRow(employeeRows);
      if (employee === null || employee.in_scope !== true) {
        throw notFound("No such employee.", "EMPLOYEE_NOT_FOUND");
      }

      const result = await withContext(ctx, async (tx) => {
        // Retire everything that is not already retired or purged. There is no
        // `re_enrol_required` column; "no live template" IS the re-enrol signal, and
        // it is what the kiosk match and the enrolment-gap alert both read.
        const retired = await tx<{ id: string; version: number }[]>`
          UPDATE secure.face_templates
             SET is_active           = false,
                 deactivated_at      = now(),
                 deactivation_reason = ${`force re-enrol: ${input.reason}`}
           WHERE employee_id = ${employee.id}::uuid
             AND deactivated_at IS NULL
             AND purged_at IS NULL
          RETURNING id, version
        `;

        await tx`
          UPDATE public.face_enrolment_requests
             SET status         = 'cancelled'::public.approval_status,
                 reviewed_by    = ${auth.userId}::uuid,
                 reviewed_at    = now(),
                 review_comment = ${`superseded by a forced re-enrolment: ${input.reason}`}::text
           WHERE employee_id = ${employee.id}::uuid
             AND status = 'pending'::public.approval_status
        `;

        await tx`
          UPDATE public.employees
             SET face_enrolled_at = NULL
           WHERE id = ${employee.id}::uuid
             AND deleted_at IS NULL
             AND face_enrolled_at IS NOT NULL
        `;

        await writeAudit(tx, ctx, {
          action: "override",
          entityTable: "secure.face_templates",
          entityId: retired[0]?.id ?? null,
          entityLabel: `${employee.employee_code} forced re-enrolment`,
          subjectEmployeeId: employee.id,
          newValue: {
            action: "force_reenrol",
            retired_template_ids: retired.map((r) => r.id),
            retired_versions: [...new Set(retired.map((r) => r.version))],
          },
          reason: input.reason,
        });

        return retired;
      });

      status = 200;
      const responseBody = {
        op: "force_reenrol" as const,
        employeeId: employee.id,
        employeeCode: employee.employee_code,
        displayName: employee.display_name,
        retiredTemplateIds: result.map((r) => r.id),
        retiredVersions: [...new Set(result.map((r) => r.version))],
        faceEnrolledAtCleared: true,
        requestId,
      };
      await store(idempotencyKey, status, responseBody);
      log.info("forced re-enrolment", { employee_id: employee.id, retired: result.length });
      return ok(responseBody, { status, headers: cors, requestId });
    }

    // ── op = purge (super_admin) ──────────────────────────────────────────────
    {
      const employeeId = input.scope === "template"
        ? (target as TargetRow).employee_id
        : (input.employee_id as string);
      const employeeRows = await withContext(ctx, async (tx) =>
        await tx<{
          id: string;
          employee_code: string;
          display_name: string | null;
          in_scope: boolean;
        }[]>`
          SELECT e.id, e.employee_code, e.display_name,
                 app.admin_scope_covers(e.id) AS in_scope
            FROM public.employees e
           WHERE e.id = ${employeeId}::uuid AND e.deleted_at IS NULL
           LIMIT 1
        `
      );
      const employee = firstRow(employeeRows);
      if (employee === null || employee.in_scope !== true) {
        throw notFound("No such employee.", "EMPLOYEE_NOT_FOUND");
      }
      // Typed confirmation: the code must be spelled out, exactly (T-19).
      if (input.confirm_employee_code !== employee.employee_code) {
        throw forbidden(
          "The confirmation code does not match this employee. Purge refused.",
          "PURGE_CONFIRMATION_MISMATCH",
        );
      }
      const version = input.scope === "template" ? (target as TargetRow).version : null;

      const result = await withContext(ctx, async (tx) => {
        // Read the paths and ids first: the UPDATE below returns the NEW row, and
        // the capture paths are about to be nulled.
        const targets = await tx<{ id: string; version: number; enrolment_photo_path: string | null }[]>`
          SELECT t.id, t.version, t.enrolment_photo_path
            FROM secure.face_templates t
           WHERE t.employee_id = ${employee.id}::uuid
             AND t.purged_at IS NULL
             AND (${version}::integer IS NULL OR t.version = ${version}::integer)
           FOR UPDATE
        `;
        if (targets.length === 0) {
          throw gone(
            "There is nothing left to purge for this employee.",
            "FACE_TEMPLATE_ALREADY_PURGED",
          );
        }
        const ids = targets.map((t) => t.id);

        // Zero the live descriptor. The row survives as evidence that a template
        // once existed and was destroyed — `ck_face_templates__dim` still holds
        // because `array_fill` is sized from `descriptor_dim`.
        const purged = await tx<{ id: string }[]>`
          UPDATE secure.face_templates t
             SET descriptor           = array_fill(0::real, ARRAY[t.descriptor_dim]),
                 purged_at            = now(),
                 is_active            = false,
                 deactivated_at       = COALESCE(t.deactivated_at, now()),
                 deactivation_reason  = COALESCE(t.deactivation_reason, ${`purged: ${input.reason}`}),
                 enrolment_photo_path = NULL
           WHERE t.id = ANY(${ids}::uuid[])
          RETURNING t.id
        `;

        // AFTER the update, not before: `trg_face_templates__version` has just
        // archived the OLD descriptor into `secure.face_template_history`. A purge
        // that leaves the archive intact is not a purge.
        const historyZeroed = await tx<{ id: string }[]>`
          UPDATE secure.face_template_history h
             SET descriptor           = array_fill(0::real, ARRAY[COALESCE(array_length(h.descriptor, 1), 128)]),
                 enrolment_photo_path = NULL
           WHERE h.face_template_id = ANY(${ids}::uuid[])
          RETURNING h.id
        `;

        const remaining = await tx<{ still_active: number }[]>`
          SELECT count(*)::integer AS still_active
            FROM secure.face_templates t
           WHERE t.employee_id = ${employee.id}::uuid AND t.is_active
        `;
        const stillActive = Number(firstRow(remaining)?.still_active ?? 0);
        if (stillActive === 0) {
          await tx`
            UPDATE public.employees
               SET face_enrolled_at = NULL
             WHERE id = ${employee.id}::uuid
               AND deleted_at IS NULL
               AND face_enrolled_at IS NOT NULL
          `;
        }

        await tx`
          UPDATE public.face_enrolment_requests
             SET status         = 'cancelled'::public.approval_status,
                 reviewed_by    = ${auth.userId}::uuid,
                 reviewed_at    = now(),
                 review_comment = ${`biometric purge: ${input.reason}`}::text
           WHERE employee_id = ${employee.id}::uuid
             AND status = 'pending'::public.approval_status
        `;

        // The two mandated records: a `purge_biometric` chain row, and a
        // data_access_log row for the subject (migration 041's `biometric_purge`
        // job description spells out both). Neither carries a descriptor or a hash
        // of one — a hash of an embedding is still a biometric identifier.
        await writeAudit(tx, ctx, {
          action: "purge_biometric",
          entityTable: "secure.face_templates",
          entityId: ids[0] ?? null,
          entityLabel: `${employee.employee_code} face templates purged (${ids.length})`,
          subjectEmployeeId: employee.id,
          oldValue: { descriptors_present: true, template_ids: ids },
          newValue: {
            descriptors_present: false,
            purged_template_ids: ids,
            purged_versions: [...new Set(targets.map((t) => t.version))],
            history_rows_zeroed: historyZeroed.length,
            scope: input.scope,
          },
          isRedacted: true,
          reason: input.reason,
        });

        await auditDataAccess(tx, ctx, {
          accessKind: "reveal",
          entityTable: "secure.face_templates",
          entityId: ids[0] ?? null,
          subjectEmployeeId: employee.id,
          fields: ["descriptor"],
          purpose: input.reason,
          recordCount: ids.length,
          filterSummary: { access: "purge", scope: input.scope, version, request_id: requestId },
        });

        return {
          ids,
          purgedCount: purged.length,
          historyZeroed: historyZeroed.length,
          versions: [...new Set(targets.map((t) => t.version))],
          paths: targets.map((t) => t.enrolment_photo_path).filter((p): p is string => p !== null),
        };
      });

      // Capture objects last: deleting them before the commit would destroy the
      // photos of a template that might still exist if the transaction rolled back.
      let capturesRemoved = true;
      if (result.paths.length > 0) {
        const { error } = await serviceClient().storage.from(CAPTURE_BUCKET).remove(result.paths);
        if (error !== null) {
          capturesRemoved = false;
          log.error("purge left capture objects behind", {
            employee_id: employee.id,
            objects: result.paths.length,
            err: error,
          });
        }
      }

      status = 200;
      const responseBody = {
        op: "purge" as const,
        scope: input.scope,
        employeeId: employee.id,
        employeeCode: employee.employee_code,
        displayName: employee.display_name,
        purgedTemplateIds: result.ids,
        purgedVersions: result.versions,
        purgedCount: result.purgedCount,
        archiveRowsZeroed: result.historyZeroed,
        captureObjects: result.paths.length,
        capturesRemoved,
        faceEnrolledAtCleared: true,
        irreversible: true as const,
        requestId,
      };
      await store(idempotencyKey, status, responseBody);
      log.info("biometric purge complete", {
        employee_id: employee.id,
        templates: result.purgedCount,
        archive_rows: result.historyZeroed,
        captures_removed: capturesRemoved,
      });
      return ok(responseBody, { status, headers: cors, requestId });
    }
  } catch (err) {
    const failure = toProblem(err, requestId).withContext({ requestId, instance });
    status = failure.status;

    if (idempotencyKey !== null) {
      try {
        if (status >= 500) await release(idempotencyKey);
        else await store(idempotencyKey, status, failure.problem);
      } catch (storeErr) {
        log.warn("could not finalise idempotency key", { key: idempotencyKey, err: storeErr });
      }
    }

    if (failure.isServerFault) log.error("unhandled failure", { err, code: failure.code });
    else log.warn("request refused", { code: failure.code, status });
    return failure.toResponse(cors);
  } finally {
    // ── STEP 12 · One structured log line per invocation ─────────────────────
    log.finish(status, { idempotency_key: idempotencyKey });
  }
});

/** Exported for `supabase/tests` and the admin client. */
export { AdminBody, ApproveOp, DeactivateOp, ForceReenrolOp, ListOp, PurgeOp };
