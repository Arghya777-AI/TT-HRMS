/**
 * face-enrolment.api.ts — the ADMIN-INITIATED half of face enrolment, for the
 * per-employee console on `/admin/kiosk/enrolment` (spec-admin §5.10,
 * spec-kiosk §2 mode M2 "web admin").
 *
 * `kiosk.api.ts` already owns the org-wide surfaces: the template list/approve/
 * deactivate/force_reenrol wrappers, the pending-request grid, consent recording
 * and the console capture submit. This module adds only what a PER-EMPLOYEE
 * console needs on top, and every fact below was read out of the migrations and
 * the deployed functions rather than assumed:
 *
 *  1. THE ROSTER. `v_enrolment_coverage` is a GAP list — its predicate is
 *     `(no consent) OR (no template)`, so it can never show an enrolled person.
 *     A console that has to say "who IS enrolled" therefore reads the admin
 *     employee view, whose `e.*` carries `face_enrolled_at` (set by
 *     `face-template-admin approve`, cleared by `force_reenrol`) and
 *     `exclude_from_attendance`. Statuses are limited to the same set
 *     `face-enrol` will accept (`ENROLLABLE_STATUSES` there), so the console
 *     never offers a capture the server would refuse.
 *
 *  2. THE INVITATION. `public.face_enrolment_requests` is the only request table
 *     that exists, and migration 012 grants an admin INSERT with
 *     `app.is_admin() AND app.admin_scope_covers(employee_id)` — no status
 *     restriction (only the SELF policy pins `status = 'pending'`). Two
 *     consequences shape this file:
 *       * `capture_path` is NOT NULL: the table was designed for employee-
 *         initiated, capture-first requests. An admin invitation has no photo,
 *         so `INVITATION_CAPTURE_PLACEHOLDER` is stored and the console renders
 *         it as absent. Nothing in this repo reads `capture_path` except
 *         `face-enrol`, which writes its own.  ← DB gap, reported, not hidden.
 *       * status is `'draft'`, NOT `'pending'`. `face-enrol` refuses with
 *         `FACE_ENROLMENT_PENDING` when ANY row for the employee is `pending`,
 *         so an invitation written as `pending` would block the very capture it
 *         asks for. `draft` is the honest value ("requested, nothing submitted")
 *         and it keeps the review queue — which filters `status = 'pending'` —
 *         exactly as it was.
 *
 *  3. THE NOTICE. `public.notifications` is partitioned on `recorded_at` and
 *     `INSERT` is revoked from `authenticated` (migration 027: service_role
 *     only), so no browser code can create the in-app row for the seeded
 *     `FACE_ENROLMENT_REQUIRED` event code. The sanctioned per-person path is
 *     `communication-send` in `mode: "transactional"` with
 *     `audience.employee_ids`, which resolves the seeded EMAIL template of the
 *     same code. That is what `notifyEnrolmentRequired` calls, and the screen
 *     says so rather than implying a bell badge appeared.
 *
 *  4. THE REFERENCE PHOTO. `face-template-admin list` will sign the enrolment
 *     capture for 60 s when asked (`include_capture_urls`), writing one
 *     `data_access` reveal row PER SUBJECT. That is a reason-carrying reveal, so
 *     it is modelled as a mutation, scoped to ONE employee, and never fired from
 *     a grid render. The descriptor is not in the response on any code path and
 *     nothing here could carry one.
 */
import { z } from "zod";
import {
  dbDate,
  dbIntNullable,
  dbTimestampNullable,
  dbUuid,
  eq,
  inList,
  selectMany,
  insertRow,
  updateRow,
  rpcMany,
} from "@/shared/api/query";
import { invokeEdgeFn } from "@/shared/api/invoke";
import { V_ADMIN_EMPLOYEE, employmentStatusSchema } from "./employees.api";
import {
  FACE_ENROLMENT_REQUESTS_TABLE,
  FACE_TEMPLATE_ADMIN_FN,
  enrolmentRequestSchema,
  faceTemplateSchema,
  type EnrolmentRequest,
} from "./kiosk.api";
import { COMMUNICATION_SEND_FN } from "./comms.api";

// -----------------------------------------------------------------------------
// 1. The enrollable roster
// -----------------------------------------------------------------------------

/**
 * The employment statuses `face-enrol` will build a template for — copied from
 * its own `ENROLLABLE_STATUSES` so the console cannot offer a capture the
 * function refuses with `EMPLOYEE_NOT_ENROLLABLE`.
 */
export const ENROLLABLE_STATUSES = [
  "pre_joining",
  "active",
  "on_probation",
  "confirmed",
  "on_notice",
  "on_long_leave",
  "rehired",
] as const;

/**
 * Exactly the columns the console renders. `face_enrolled_at` is the employee
 * record's own answer to "is this face live at the gate" — it is stamped by the
 * approval and cleared by a forced re-enrolment, so it is trustworthy without
 * touching the secure schema.
 */
const ROSTER_COLUMNS = [
  "id",
  "employee_code",
  "display_name",
  "employment_status",
  "department_name",
  "designation_name",
  "date_of_join",
  "work_email",
  "face_enrolled_at",
  "exclude_from_attendance",
].join(",");

export const enrolmentRosterRowSchema = z.object({
  id: dbUuid,
  employee_code: z.string(),
  display_name: z.string(),
  employment_status: employmentStatusSchema,
  department_name: z.string().nullable(),
  designation_name: z.string().nullable(),
  date_of_join: dbDate,
  work_email: z.string().nullable(),
  /** Set by `face-template-admin approve`; cleared by `force_reenrol`. */
  face_enrolled_at: dbTimestampNullable,
  exclude_from_attendance: z.boolean(),
});
export type EnrolmentRosterRow = z.infer<typeof enrolmentRosterRowSchema>;

/**
 * Every employee a face MAY be enrolled for, enrolled or not.
 *
 * `v_admin_employee` is already admin-scoped and soft-delete-filtered in the
 * view itself (`WHERE e.deleted_at IS NULL AND app.is_admin() AND
 * app.admin_scope_covers(e.id)`), so there is no client-side scope guess here.
 */
export function fetchEnrolmentRoster(
  limit = 500,
  signal?: AbortSignal,
): Promise<EnrolmentRosterRow[]> {
  return selectMany(V_ADMIN_EMPLOYEE, enrolmentRosterRowSchema, {
    filters: [inList("employment_status", ENROLLABLE_STATUSES)],
    order: [{ column: "employee_code", ascending: true }],
    columns: ROSTER_COLUMNS,
    limit,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 2. Admin-initiated enrolment requests
// -----------------------------------------------------------------------------

/**
 * `face_enrolment_requests.capture_path` is NOT NULL and an invitation has no
 * photo. A reserved sentence — not a storage key — is stored so that nothing can
 * mistake it for an object to sign, and `isInvitationCapture()` keeps it off the
 * screen.
 */
export const INVITATION_CAPTURE_PLACEHOLDER =
  "(no capture — admin-initiated enrolment invitation)";

export function isInvitationCapture(capturePath: string | null): boolean {
  return capturePath === null || capturePath === INVITATION_CAPTURE_PLACEHOLDER;
}

/** `ck_face_enrolment_requests__via` allows exactly 'web' and 'kiosk'. */
const REQUESTED_VIA_WEB = "web";

/**
 * `public.approval_status` values this console writes. `draft` is the invitation
 * (see the header); `applied` closes it once a capture happened; `cancelled`
 * closes it when the request is dropped. Nothing here writes `pending` — only
 * `face-enrol` does, and only with a real capture attached.
 */
export const INVITATION_OPEN_STATUS = "draft";
export const INVITATION_FULFILLED_STATUS = "applied";
export const INVITATION_CANCELLED_STATUS = "cancelled";

/**
 * Written by `face-enrol` ALONE, and only with a real capture attached. Nothing
 * in the browser may write it: a `pending` row is what makes `face-enrol` refuse
 * the next capture (`FACE_ENROLMENT_PENDING`) and what the review queue lists.
 */
export const INVITATION_SUBMITTED_STATUS = "pending";

/** An open request an admin can act on: the invitation, or a submitted capture. */
export function isOpenRequest(request: EnrolmentRequest): boolean {
  return (
    request.status === INVITATION_OPEN_STATUS || request.status === INVITATION_SUBMITTED_STATUS
  );
}

/**
 * Record that an administrator has asked this employee to enrol.
 *
 * Written through `insertRow`, so the reason reaches `x-reason` →
 * `app.reason` and the row's audit entry (`trg_face_enrolment_requests__audit`,
 * migration 038) carries why the request exists. `status`/`capture_path` are
 * spelled out rather than left to defaults precisely because the defaults
 * (`pending`, none) are wrong for an invitation.
 */
export function createEnrolmentInvitation(
  employeeId: string,
  reason: string,
  signal?: AbortSignal,
): Promise<EnrolmentRequest> {
  return insertRow(
    FACE_ENROLMENT_REQUESTS_TABLE,
    {
      employee_id: employeeId,
      requested_via: REQUESTED_VIA_WEB,
      capture_path: INVITATION_CAPTURE_PLACEHOLDER,
      status: INVITATION_OPEN_STATUS,
    },
    enrolmentRequestSchema,
    { reason, ...(signal ? { signal } : {}) },
  );
}

/**
 * Close an open request: `applied` when the capture happened, `cancelled` when
 * the ask is withdrawn. `review_comment` carries the same sentence the audit row
 * gets, so the row itself explains its own closure to the next reader.
 */
export function closeEnrolmentRequest(
  input: {
    readonly requestId: string;
    readonly outcome: typeof INVITATION_FULFILLED_STATUS | typeof INVITATION_CANCELLED_STATUS;
  },
  reason: string,
  signal?: AbortSignal,
): Promise<EnrolmentRequest> {
  return updateRow(
    FACE_ENROLMENT_REQUESTS_TABLE,
    [eq("id", input.requestId)],
    { status: input.outcome, review_comment: reason },
    enrolmentRequestSchema,
    { reason, ...(signal ? { signal } : {}) },
  );
}

// -----------------------------------------------------------------------------
// 3. Notifying the employee
// -----------------------------------------------------------------------------

/** Seeded in migration 045 for both the `in_app` and `email` channels. */
export const FACE_ENROLMENT_EVENT_CODE = "FACE_ENROLMENT_REQUIRED";

/** `ck_communications__kind` — an enrolment nudge is a reminder. */
const COMMUNICATION_KIND_REMINDER = "reminder";

/** The machine code `communication-send` raises when no transport is provisioned. */
export const EMAIL_TRANSPORT_UNCONFIGURED = "EMAIL_TRANSPORT_UNCONFIGURED";

export const enrolmentNoticeResultSchema = z.object({
  communication_id: dbUuid,
  communication_number: z.string(),
  status: z.string(),
  recipients: z.object({
    total: z.number(),
    sent: z.number().optional(),
    failed: z.number().optional(),
    deferred: z.number().optional(),
    suppressed: z.number().optional(),
    queued: z.number().optional(),
  }),
});
export type EnrolmentNoticeResult = z.infer<typeof enrolmentNoticeResultSchema>;

/**
 * Send the seeded FACE_ENROLMENT_REQUIRED notice to ONE employee.
 *
 * `audience.employee_ids` is a real selector on the function's `Audience` schema;
 * `max_recipients: 1` means a mis-typed id can never fan out to the venue. The
 * function resolves the EMAIL template for the code (`resolveTemplate`, channel
 * `'email'`), which migration 045 seeded, and refuses with `TEMPLATE_NOT_FOUND`
 * rather than inventing copy if it is ever deleted.
 *
 * NO REASON PARAMETER, deliberately: `SendBody` is `.strict()` and has no
 * `reason` field — the function reads `x-reason`, which `invokeEdgeFn` does not
 * send — so a `reason` argument here would be a sentence that goes nowhere. The
 * administrator's typed reason is recorded on the enrolment-request row that
 * accompanies this notice, and the function writes its own audit row with a
 * generated provenance sentence.
 */
export function notifyEnrolmentRequired(
  employeeId: string,
  opts: { readonly idempotencyKey?: string; readonly signal?: AbortSignal } = {},
): Promise<EnrolmentNoticeResult> {
  return invokeEdgeFn(
    COMMUNICATION_SEND_FN,
    {
      mode: "transactional",
      communication_kind: COMMUNICATION_KIND_REMINDER,
      audience: { employee_ids: [employeeId] },
      message: { template_code: FACE_ENROLMENT_EVENT_CODE },
      max_recipients: 1,
      dry_run: false,
    },
    enrolmentNoticeResultSchema,
    {
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
  );
}

// -----------------------------------------------------------------------------
// 4. One employee's templates, with the reference photo signed
// -----------------------------------------------------------------------------

/**
 * The list row plus the two capture fields the grid path deliberately never asks
 * for. `faceTemplateSchema` is extended rather than re-declared so the console
 * and `/admin/kiosk/templates` cannot drift on what a template row is.
 */
export const revealedTemplateSchema = faceTemplateSchema.extend({
  /** Signed for `captureUrlExpiresInSeconds`; null when there is nothing to sign. */
  captureUrl: z.string().nullable(),
  captureUrlExpiresInSeconds: dbIntNullable,
});
export type RevealedTemplate = z.infer<typeof revealedTemplateSchema>;

const revealResultSchema = z.object({
  op: z.literal("list"),
  total: z.number(),
  templates: z.array(revealedTemplateSchema),
});
export type TemplateRevealResult = z.infer<typeof revealResultSchema>;

/**
 * Reveal the enrolment reference photo(s) for ONE employee.
 *
 * `state: "all"` because the photo an approver needs may hang off a pending set,
 * an active one, or a retired one being investigated. The function writes the
 * `bulk_view` row for the read and one `reveal` row for this subject, using the
 * reason below — the client never decides whether the reveal was audited.
 */
export function revealEmployeeTemplates(
  employeeId: string,
  reason: string,
  opts: { readonly idempotencyKey?: string; readonly signal?: AbortSignal } = {},
): Promise<TemplateRevealResult> {
  return invokeEdgeFn(
    FACE_TEMPLATE_ADMIN_FN,
    {
      op: "list",
      employee_id: employeeId,
      state: "all",
      include_capture_urls: true,
      reason,
      limit: 20,
      offset: 0,
    },
    revealResultSchema,
    {
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
  );
}

// -----------------------------------------------------------------------------
// 5. The caller's own capabilities (UX gate only)
// -----------------------------------------------------------------------------

/** `public.my_capabilities()` — migration 050, granted to `authenticated`. */
export const MY_CAPABILITIES_FN = "my_capabilities";

/** The two capabilities this console's buttons are shaped by. */
export const CAP_BIOMETRIC_ENROL = "biometric.enrol";
export const CAP_TEMPLATE_MANAGE = "biometric.template.manage";

/**
 * Every capability the caller's roles hold, resolved in Postgres against
 * `role_capabilities` with the role hierarchy applied.
 *
 * UX ONLY. It hides a button the server would refuse anyway; RLS and
 * `requireCapWithStepUp` remain the boundary. Reading it is not sensitive — the
 * table says what a ROLE may do, not who holds it, and its RLS policy is
 * `USING (true)` for authenticated users.
 */
export function fetchMyCapabilities(signal?: AbortSignal): Promise<string[]> {
  return rpcMany(MY_CAPABILITIES_FN, {}, z.string(), { ...(signal ? { signal } : {}) });
}
