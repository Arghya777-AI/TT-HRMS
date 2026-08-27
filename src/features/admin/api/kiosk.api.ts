/**
 * kiosk.api.ts — reads and writes for the six kiosk/biometrics admin screens
 * (`/admin/kiosk/{devices,operators,enrolment,templates,match-review,consent}`).
 *
 * The biometric boundary this module respects, verified against the deployed
 * migrations rather than assumed:
 *
 *  * `secure.face_templates` and `secure.biometric_consents` have ZERO grants to
 *    `authenticated` (migration 012 §13) and no PostgREST-reachable view. The
 *    ONLY admin path to template metadata is the `face-template-admin` edge
 *    function, whose `list` op selects its columns explicitly and never returns
 *    `descriptor`. So this module reaches templates through `invokeEdgeFn`, not
 *    through PostgREST — and there is no code path here that could carry a
 *    128-D embedding even if someone tried.
 *  * `secure.face_match_log` is readable only through `public.v_face_match_audit`
 *    (owner-executed, `WHERE app.is_admin()`), which deliberately omits
 *    `candidate_scores`. Those need `reveal_face_match_candidates(id, reason)`,
 *    super-admin only, and every call writes a `data_access` reveal row.
 *  * `kiosk_devices` is admin-READ / super-admin-WRITE and is in
 *    `audit.reason_required_tables`, so every device write goes through the
 *    audited helpers with a typed reason.
 *
 * Device write helpers live in `system.api.ts` (`fetchKioskDevices`,
 * `updateKioskDevice`); this module adds the fleet's *state derivation* and the
 * operator/template/match/consent surfaces on top.
 */
import { z } from "zod";
import {
  SENSITIVE_REASON_LENGTH,
  dbDate,
  dbInt,
  dbIntNullable,
  dbNumericNullable,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  gte,
  inList,
  lte,
  rpcMany,
  selectMany,
  updateRow,
  type Filter,
} from "@/shared/api/query";
import { invokeEdgeFn } from "@/shared/api/invoke";
import { nowInstantIso } from "@/lib/datetime";
import { updateKioskDevice, type KioskDevice } from "./system.api";

export const KIOSK_OPERATORS_TABLE = "kiosk_operators";
export const FACE_ENROLMENT_REQUESTS_TABLE = "face_enrolment_requests";
export const V_FACE_MATCH_AUDIT = "v_face_match_audit";
export const FACE_TEMPLATE_ADMIN_FN = "face-template-admin";
export const REVEAL_CANDIDATES_FN = "reveal_face_match_candidates";

/** Default reason for the routine operator-permission edits (§17). */
export const REASON_OPERATOR_EDIT = "admin console: edited kiosk operator permissions";

// -----------------------------------------------------------------------------
// 1. Kiosk operators (`/admin/kiosk/operators`) — §17
// -----------------------------------------------------------------------------

export const kioskOperatorSchema = z.object({
  id: dbUuid,
  profile_id: dbUuid,
  employee_id: dbUuidNullable,
  kiosk_device_id: dbUuidNullable,
  can_enrol_faces: z.boolean(),
  can_manual_punch: z.boolean(),
  /** Free text on the row, e.g. 'Morning 06:00–14:00'. Not a parsed range. */
  shift_window: z.string().nullable(),
  is_active: z.boolean(),
  last_signed_in_at: dbTimestampNullable,
  created_at: dbTimestamp,
  updated_at: dbTimestamp,
});
export type KioskOperator = z.infer<typeof kioskOperatorSchema>;

export function fetchKioskOperators(signal?: AbortSignal): Promise<KioskOperator[]> {
  return selectMany(KIOSK_OPERATORS_TABLE, kioskOperatorSchema, {
    order: [
      { column: "is_active", ascending: false },
      { column: "created_at", ascending: false },
    ],
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

/**
 * The permissions a guard row can carry. `profile_id` / `employee_id` are NOT
 * patchable here: re-pointing an operator row at a different person would move
 * a punching credential without any of the §17 grant ceremony.
 */
export interface OperatorPatch {
  readonly can_enrol_faces?: boolean;
  readonly can_manual_punch?: boolean;
  readonly shift_window?: string | null;
  readonly is_active?: boolean;
  readonly kiosk_device_id?: string | null;
}

/**
 * Only the keys the caller actually set reach the wire. Spreading the interface
 * straight through would send `{ can_enrol_faces: undefined }` for an unrelated
 * edit, and PostgREST writes an explicit null for that.
 */
function operatorPatchColumns(patch: OperatorPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.can_enrol_faces !== undefined) out["can_enrol_faces"] = patch.can_enrol_faces;
  if (patch.can_manual_punch !== undefined) out["can_manual_punch"] = patch.can_manual_punch;
  if (patch.shift_window !== undefined) out["shift_window"] = patch.shift_window;
  if (patch.is_active !== undefined) out["is_active"] = patch.is_active;
  if (patch.kiosk_device_id !== undefined) out["kiosk_device_id"] = patch.kiosk_device_id;
  return out;
}

export function updateKioskOperator(
  id: string,
  patch: OperatorPatch,
  reason: string,
  signal?: AbortSignal,
): Promise<KioskOperator> {
  return updateRow(
    KIOSK_OPERATORS_TABLE,
    [eq("id", id)],
    operatorPatchColumns(patch),
    kioskOperatorSchema,
    { reason, ...(signal ? { signal } : {}) },
  );
}

/** Revoke a guard's kiosk access. Sensitive: it is an access change (§17). */
export function revokeKioskOperator(
  id: string,
  reason: string,
  signal?: AbortSignal,
): Promise<KioskOperator> {
  return updateRow(
    KIOSK_OPERATORS_TABLE,
    [eq("id", id)],
    { is_active: false },
    kioskOperatorSchema,
    { reason, minReasonLength: SENSITIVE_REASON_LENGTH, ...(signal ? { signal } : {}) },
  );
}

// -----------------------------------------------------------------------------
// 2. Face templates (`/admin/kiosk/templates`) — metadata ONLY
// -----------------------------------------------------------------------------

/**
 * The quality vocabulary the server already speaks. `face-template-admin`
 * computes the band itself (`qualityBand()`); we take its word for it and never
 * re-derive a band from the raw score, so the console and the function cannot
 * disagree about what "fair" means.
 */
export const qualityBandSchema = z.enum(["good", "fair", "poor"]);
export type QualityBand = z.infer<typeof qualityBandSchema>;

export const templateStateSchema = z.enum(["active", "pending_approval", "inactive", "purged"]);
export type TemplateState = z.infer<typeof templateStateSchema>;

/**
 * One template SET as the edge function reports it.
 *
 * `qualityScore`, `intraSampleMaxDistance` and `pose` are present in the wire
 * payload; the screens render the BAND and the sample count only. The raw
 * numbers stay out of the UI because a face-quality number on screen is a match
 * score by another name, and the spec's vocabulary here is good/fair/poor.
 */
export const faceTemplateSchema = z.object({
  templateId: dbUuid,
  employeeId: dbUuid,
  employeeCode: z.string(),
  displayName: z.string().nullable(),
  employmentStatus: z.string(),
  version: dbInt,
  state: templateStateSchema,
  isActive: z.boolean(),
  isRepresentative: z.boolean(),
  sampleCount: dbInt,
  descriptorDim: dbInt,
  qualityBand: qualityBandSchema,
  enrolledAt: dbTimestampNullable,
  enrolledByName: z.string().nullable(),
  enrolledDeviceCode: z.string().nullable(),
  approvedAt: dbTimestampNullable,
  approvedByName: z.string().nullable(),
  deactivatedAt: dbTimestampNullable,
  deactivationReason: z.string().nullable(),
  purgedAt: dbTimestampNullable,
  consent: z.object({
    version: z.string().nullable(),
    grantedAt: dbTimestampNullable,
    withdrawnAt: dbTimestampNullable,
  }),
  enrolmentRequest: z
    .object({
      id: dbUuid,
      status: z.string().nullable(),
      requestedAt: dbTimestampNullable,
      requestedVia: z.string().nullable(),
      reviewComment: z.string().nullable(),
    })
    .nullable(),
});
export type FaceTemplate = z.infer<typeof faceTemplateSchema>;

const templateListSchema = z.object({
  op: z.literal("list"),
  state: z.string(),
  total: dbInt,
  limit: dbInt,
  offset: dbInt,
  // `.passthrough()` on each row: the function sends pose/quality numbers we
  // deliberately do not model. Unknown keys are dropped by zod's default strip,
  // which is exactly the containment we want at this boundary.
  templates: z.array(faceTemplateSchema),
});
export type TemplateListPage = z.infer<typeof templateListSchema>;

export type TemplateListState = "all" | "pending" | "active" | "inactive" | "purged";

export function fetchFaceTemplates(
  input: { state: TemplateListState; limit?: number; offset?: number; employeeId?: string },
  signal?: AbortSignal,
): Promise<TemplateListPage> {
  return invokeEdgeFn(
    FACE_TEMPLATE_ADMIN_FN,
    {
      op: "list",
      state: input.state,
      limit: input.limit ?? 50,
      offset: input.offset ?? 0,
      // Never ask for signed capture URLs from a list screen: each one writes a
      // per-subject `reveal` audit row, and a grid does not need a face photo.
      include_capture_urls: false,
      ...(input.employeeId !== undefined ? { employee_id: input.employeeId } : {}),
    },
    templateListSchema,
    { ...(signal ? { signal } : {}) },
  );
}

const approveResultSchema = z.object({
  op: z.literal("approve"),
  templateId: dbUuid,
  employeeCode: z.string(),
  version: dbInt,
  approvedSampleCount: dbInt,
});
export type ApproveResult = z.infer<typeof approveResultSchema>;

/** Activate a pending set, retiring the previous version. Reason is mandatory. */
export function approveFaceTemplate(
  input: { templateId: string; comment?: string; idempotencyKey: string },
  reason: string,
  signal?: AbortSignal,
): Promise<ApproveResult> {
  return invokeEdgeFn(
    FACE_TEMPLATE_ADMIN_FN,
    {
      op: "approve",
      template_id: input.templateId,
      reason,
      ...(input.comment !== undefined && input.comment !== "" ? { comment: input.comment } : {}),
    },
    approveResultSchema,
    { idempotencyKey: input.idempotencyKey, ...(signal ? { signal } : {}) },
  );
}

const deactivateResultSchema = z.object({
  op: z.literal("deactivate"),
  templateId: dbUuid,
  employeeCode: z.string(),
  version: dbInt,
  wasPending: z.boolean(),
  employeeStillEnrolled: z.boolean(),
});
export type DeactivateResult = z.infer<typeof deactivateResultSchema>;

/** Retire a version. This is ALSO how a pending self-enrolment is rejected. */
export function deactivateFaceTemplate(
  input: { templateId: string; idempotencyKey: string },
  reason: string,
  signal?: AbortSignal,
): Promise<DeactivateResult> {
  return invokeEdgeFn(
    FACE_TEMPLATE_ADMIN_FN,
    { op: "deactivate", template_id: input.templateId, reason },
    deactivateResultSchema,
    { idempotencyKey: input.idempotencyKey, ...(signal ? { signal } : {}) },
  );
}

const forceReenrolResultSchema = z.object({
  op: z.literal("force_reenrol"),
  employeeCode: z.string(),
  retiredVersions: z.array(dbInt),
});
export type ForceReenrolResult = z.infer<typeof forceReenrolResultSchema>;

/** Retire everything an employee has, so the gate stops matching them (§5.10). */
export function forceReenrol(
  input: { employeeId: string; idempotencyKey: string },
  reason: string,
  signal?: AbortSignal,
): Promise<ForceReenrolResult> {
  return invokeEdgeFn(
    FACE_TEMPLATE_ADMIN_FN,
    { op: "force_reenrol", employee_id: input.employeeId, reason },
    forceReenrolResultSchema,
    { idempotencyKey: input.idempotencyKey, ...(signal ? { signal } : {}) },
  );
}

// -----------------------------------------------------------------------------
// 3. Self-enrolment requests (`/admin/kiosk/enrolment`)
// -----------------------------------------------------------------------------

export const enrolmentRequestSchema = z.object({
  id: dbUuid,
  employee_id: dbUuid,
  requested_at: dbTimestamp,
  /** 'web' | 'kiosk'. */
  requested_via: z.string(),
  /** 0–1 on the row; the queue shows a band, never the number. */
  quality_score: dbNumericNullable,
  status: z.string(),
  reviewed_at: dbTimestampNullable,
  review_comment: z.string().nullable(),
  resulting_template_id: dbUuidNullable,
});
export type EnrolmentRequest = z.infer<typeof enrolmentRequestSchema>;

export function fetchEnrolmentRequests(
  f: { onlyPending?: boolean } = {},
  signal?: AbortSignal,
): Promise<EnrolmentRequest[]> {
  const filters: Filter[] = [];
  if (f.onlyPending === true) filters.push(eq("status", "pending"));
  return selectMany(FACE_ENROLMENT_REQUESTS_TABLE, enrolmentRequestSchema, {
    filters,
    order: [{ column: "requested_at", ascending: false }],
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. Match review (`/admin/kiosk/match-review`) — v_face_match_audit
// -----------------------------------------------------------------------------

export const matchOutcomeValues = [
  "matched",
  "no_match",
  "ambiguous",
  "no_face",
  "multiple_faces",
  "low_quality",
  "liveness_failed",
  "error",
  "duplicate_suppressed",
] as const;
export type MatchOutcome = (typeof matchOutcomeValues)[number];

/** The outcomes a human actually has to look at (§5.9 / route hint). */
export const REVIEW_OUTCOMES: readonly MatchOutcome[] = [
  "ambiguous",
  "no_match",
  "liveness_failed",
  "low_quality",
  "multiple_faces",
  "error",
];

export const faceMatchAuditSchema = z.object({
  id: dbUuid,
  attempted_at: dbTimestamp,
  ist_date: dbDate,
  kiosk_device_id: dbUuidNullable,
  operator_id: dbUuidNullable,
  /** The "N" in 1:N — how many templates were compared. */
  candidate_set_size: dbInt,
  outcome: z.string(),
  matched_employee_id: dbUuidNullable,
  best_distance: dbNumericNullable,
  best_confidence: dbNumericNullable,
  runner_up_employee_id: dbUuidNullable,
  runner_up_distance: dbNumericNullable,
  /** runner_up_distance − best_distance. Below the configured floor ⇒ ambiguous. */
  margin: dbNumericNullable,
  /** Pinned at decision time; a later policy change cannot rewrite history. */
  threshold_used: dbNumericNullable,
  model_version: z.string(),
  detector_score: dbNumericNullable,
  liveness_score: dbNumericNullable,
  latency_ms: dbIntNullable,
  produced_punch_id: dbUuidNullable,
  app_version: z.string().nullable(),
  error_detail: z.string().nullable(),
});
export type FaceMatchAudit = z.infer<typeof faceMatchAuditSchema>;

/** Projection excludes `capture_photo_path` and `ip` — neither belongs in a grid. */
const MATCH_COLUMNS = [
  "id",
  "attempted_at",
  "ist_date",
  "kiosk_device_id",
  "operator_id",
  "candidate_set_size",
  "outcome",
  "matched_employee_id",
  "best_distance",
  "best_confidence",
  "runner_up_employee_id",
  "runner_up_distance",
  "margin",
  "threshold_used",
  "model_version",
  "detector_score",
  "liveness_score",
  "latency_ms",
  "produced_punch_id",
  "app_version",
  "error_detail",
].join(",");

export interface MatchAuditFilters {
  readonly from: string;
  readonly to: string;
  readonly outcomes?: readonly string[];
  readonly deviceIds?: readonly string[];
}

export function fetchFaceMatchAudit(
  f: MatchAuditFilters,
  limit = 300,
  signal?: AbortSignal,
): Promise<FaceMatchAudit[]> {
  const filters: Filter[] = [gte("ist_date", f.from), lte("ist_date", f.to)];
  if (f.outcomes && f.outcomes.length > 0) filters.push(inList("outcome", f.outcomes));
  if (f.deviceIds && f.deviceIds.length > 0) filters.push(inList("kiosk_device_id", f.deviceIds));
  return selectMany(V_FACE_MATCH_AUDIT, faceMatchAuditSchema, {
    filters,
    order: [{ column: "attempted_at", ascending: false }],
    columns: MATCH_COLUMNS,
    limit,
    ...(signal ? { signal } : {}),
  });
}

export const candidateRevealSchema = z.object({
  id: dbUuid,
  attempted_at: dbTimestamp,
  outcome: z.string(),
  matched_employee_id: dbUuidNullable,
  best_confidence: dbNumericNullable,
  margin: dbNumericNullable,
  /** Top-5 `[{employee_id, distance}]`. Shape is the engine's, not ours. */
  candidate_scores: z.unknown().nullable(),
});
export type CandidateReveal = z.infer<typeof candidateRevealSchema>;

/**
 * Super-admin only. `app.assert_reveal_allowed` refuses a short reason and
 * `app.log_reveal` writes one `data_access` row per call — the reveal IS the
 * audited event, so this is never called speculatively on grid render.
 */
export async function revealFaceMatchCandidates(
  matchId: string,
  reason: string,
  signal?: AbortSignal,
): Promise<CandidateReveal | null> {
  const rows = await rpcMany(
    REVEAL_CANDIDATES_FN,
    { p_face_match_log_id: matchId, p_reason: reason },
    candidateRevealSchema,
    { ...(signal ? { signal } : {}) },
  );
  return rows[0] ?? null;
}

// -----------------------------------------------------------------------------
// 5. Device fleet state (`/admin/kiosk/devices`)
// -----------------------------------------------------------------------------

/**
 * The five states §5.11 names. Derived from the device row's own columns — this
 * is a presentation mapping over `revoked_at` / `is_active` / `last_seen_at` /
 * `clock_skew_seconds`, not a computed business figure.
 *
 * `pending_pairing` is "the row exists but no tablet has ever checked in", which
 * is exactly `last_seen_at IS NULL`.
 */
export type DeviceState = "pending_pairing" | "active" | "degraded" | "offline" | "revoked";

/** §5.11: skew above 90 s degrades the device and flags its punches. */
export const CLOCK_SKEW_DEGRADED_SECONDS = 90;

export interface DeviceStateInput {
  readonly revoked_at: string | null;
  readonly is_active: boolean;
  readonly last_seen_at: string | null;
  readonly clock_skew_seconds: number | null;
}

export function deviceState(
  device: DeviceStateInput,
  minutesSinceLastSeen: number | null,
  offlineAfterMinutes: number,
): DeviceState {
  if (device.revoked_at !== null) return "revoked";
  if (device.last_seen_at === null) return "pending_pairing";
  if (!device.is_active) return "revoked";
  const skew = device.clock_skew_seconds ?? 0;
  if (Math.abs(skew) > CLOCK_SKEW_DEGRADED_SECONDS) return "degraded";
  if (minutesSinceLastSeen !== null && minutesSinceLastSeen > offlineAfterMinutes) return "offline";
  return "active";
}

/**
 * Revoke a device's pairing. Super-admin only at the policy layer
 * (`kiosk_devices__super_admin_write`), reason-required by the audit trigger.
 *
 * Revoking is also the deployed way to ROTATE the device secret: the tablet must
 * re-run `kiosk-device-activate`, which mints a fresh `kdt_…` secret and writes
 * the new hash. There is no browser-callable "rotate in place" endpoint, and
 * this module does not pretend otherwise.
 */
export function revokeKioskDevicePairing(
  id: string,
  reason: string,
  signal?: AbortSignal,
): Promise<KioskDevice> {
  return updateKioskDevice(
    id,
    { revoked_at: nowInstantIso(), is_active: false },
    reason,
    signal,
  );
}

/** Clear the revocation so the tablet may pair again with a fresh code. */
export function restoreKioskDevicePairing(
  id: string,
  reason: string,
  signal?: AbortSignal,
): Promise<KioskDevice> {
  return updateKioskDevice(id, { revoked_at: null, is_active: true }, reason, signal);
}

/**
 * Change the automatic-acceptance floor for one gate (§5.9 threshold
 * governance: a global change is super-admin plus a reason, and it shows as a
 * marker on the kiosk analytics chart).
 */
export function setDeviceMatchThreshold(
  id: string,
  minMatchConfidence: number,
  reason: string,
  signal?: AbortSignal,
): Promise<KioskDevice> {
  return updateKioskDevice(id, { min_match_confidence: minMatchConfidence }, reason, signal);
}

// -----------------------------------------------------------------------------
// Provisioning — kiosk-provision (deployed 26 Jul): the producer half of pairing
// codes, guard PINs and biometric consent. Each op returns its secret exactly
// once; at rest only Argon2id hashes exist.
// -----------------------------------------------------------------------------

export const KIOSK_PROVISION_FN = "kiosk-provision";

export const activationCodeResultSchema = z.object({
  op: z.literal("issue_activation_code"),
  deviceCode: z.string(),
  label: z.string(),
  /** Shown ONCE. Never stored, never logged. */
  activationCode: z.string(),
  expiresAt: z.string(),
  ttlMinutes: dbInt,
});
export type ActivationCodeResult = z.infer<typeof activationCodeResultSchema>;

/** Mint a one-time 6-digit pairing code for a device. Re-issuing revokes the old one. */
export function issueActivationCode(
  deviceId: string,
  reason: string,
  signal?: AbortSignal,
): Promise<ActivationCodeResult> {
  return invokeEdgeFn(
    KIOSK_PROVISION_FN,
    { op: "issue_activation_code", device_id: deviceId, reason },
    activationCodeResultSchema,
    { ...(signal ? { signal } : {}) },
  );
}

export const addDeviceResultSchema = z.object({
  op: z.literal("add_device"),
  deviceId: dbUuid,
  /** Generated server-side. The person pairing never types or sees this. */
  deviceCode: z.string(),
  label: z.string(),
  /** Shown ONCE. Never stored, never logged. */
  activationCode: z.string(),
  expiresAt: z.string(),
  ttlMinutes: dbInt,
});
export type AddDeviceResult = z.infer<typeof addDeviceResultSchema>;

/**
 * Create a gate device AND its first pairing code in one action.
 *
 * There was no way to add a device at all: `issue_activation_code` needs a
 * `device_id`, and the only row in `kiosk_devices` came from a migration — so the
 * fleet was permanently one tablet.
 *
 * `label` is optional and `device_code` is not an input: the server generates the
 * code, and whoever pairs the device names it from the kiosk screen. That is the
 * client's requirement — "the device name shouldn't matter; they can put anything
 * for the device name. Only the pairing code should match."
 */
export function addKioskDevice(
  input: { label?: string; locationId?: string },
  reason: string,
  signal?: AbortSignal,
): Promise<AddDeviceResult> {
  return invokeEdgeFn(
    KIOSK_PROVISION_FN,
    {
      op: "add_device",
      // Keys are OMITTED rather than sent as undefined/"": the server schema is
      // strict and an empty label would become the device's name.
      ...(input.label !== undefined && input.label.trim() !== ""
        ? { label: input.label.trim() }
        : {}),
      ...(input.locationId !== undefined ? { location_id: input.locationId } : {}),
      reason,
    },
    addDeviceResultSchema,
    { ...(signal ? { signal } : {}) },
  );
}

export const setPinResultSchema = z.object({
  op: z.literal("set_operator_pin"),
  operatorId: dbUuid,
  operatorName: z.string().nullable(),
  rotationGraceMinutes: dbInt,
});
export type SetPinResult = z.infer<typeof setPinResultSchema>;

/** Set or rotate a guard's kiosk PIN (4–10 digits). */
export function setOperatorPin(
  input: { operatorId: string; pin: string },
  reason: string,
  signal?: AbortSignal,
): Promise<SetPinResult> {
  return invokeEdgeFn(
    KIOSK_PROVISION_FN,
    { op: "set_operator_pin", operator_id: input.operatorId, pin: input.pin, reason },
    setPinResultSchema,
    { ...(signal ? { signal } : {}) },
  );
}

export const consentResultSchema = z.object({
  op: z.literal("record_consent"),
  employeeId: dbUuid,
  consentId: dbUuid,
  consentVersion: z.string(),
  alreadyOnFile: z.boolean(),
});
export type ConsentResult = z.infer<typeof consentResultSchema>;

/** Record biometric consent (admin attests the signed notice). Supersedes older versions. */
export function recordBiometricConsent(
  employeeId: string,
  reason: string,
  signal?: AbortSignal,
): Promise<ConsentResult> {
  return invokeEdgeFn(
    KIOSK_PROVISION_FN,
    { op: "record_consent", employee_id: employeeId, attested: true, reason },
    consentResultSchema,
    { ...(signal ? { signal } : {}) },
  );
}

// -----------------------------------------------------------------------------
// Console enrolment — the U+ path of face-enrol (`biometric.enrol`). The admin
// captures 5 guided samples with the console camera; the set parks as PENDING
// and activation stays a second human act behind step-up.
// -----------------------------------------------------------------------------

export const FACE_ENROL_FN = "face-enrol";
/** Must equal the server's configured model (falls back to this constant there). */
export const DESCRIPTOR_MODEL = "faceapi-rn34-128d-v1";

export interface EnrolSampleInput {
  readonly index: number;
  readonly captured_at: string;
  readonly descriptor: readonly number[];
  readonly metrics: {
    readonly detection_score: number;
    readonly sharpness: number;
    readonly brightness: number;
    readonly contrast: number;
    readonly face_px: number;
    readonly face_fraction: number;
    readonly yaw: number;
    readonly pitch: number;
    readonly roll: number;
  };
  readonly pose_prompt?: "straight" | "left" | "right" | "chin_down" | "smile";
  readonly capture?: { content_type: "image/jpeg"; data_base64: string };
}

export const consoleEnrolResultSchema = z.object({
  templateId: dbUuid,
  enrolmentRequestId: dbUuidNullable.optional(),
  employeeCode: z.string().optional(),
  displayName: z.string().optional(),
  version: dbInt.optional(),
  acceptedSamples: dbInt.optional(),
  /*
    Was `z.literal(true)`, which only ever held while every enrolment queued. An
    admin-performed enrolment is now auto-approved and returns false, and a literal would have
    thrown a validation error on the success path — the enrolment committed server-side and the
    console reporting a failure.
  */
  requiresApproval: z.boolean().optional(),
  /** True when this enrolment went live immediately, so the UI can say so instead of guessing. */
  autoApproved: z.boolean().optional(),
  webPunchGranted: z.boolean().optional(),
});
export type ConsoleEnrolResult = z.infer<typeof consoleEnrolResultSchema>;

export function enrolFaceFromConsole(
  input: { employeeId: string; samples: readonly EnrolSampleInput[] },
  reason: string,
  signal?: AbortSignal,
): Promise<ConsoleEnrolResult> {
  return invokeEdgeFn(
    FACE_ENROL_FN,
    {
      employee_id: input.employeeId,
      samples: input.samples,
      descriptor_model: DESCRIPTOR_MODEL,
      reason,
    },
    consoleEnrolResultSchema,
    { ...(signal ? { signal } : {}) },
  );
}
