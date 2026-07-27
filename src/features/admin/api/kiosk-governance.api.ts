/**
 * kiosk-governance.api.ts — the three GOVERNANCE surfaces over the gate:
 * `/admin/kiosk/abuse`, `/admin/kiosk/policy` and `/admin/kiosk/purge`.
 *
 * Split out of `kiosk.api.ts` (which owns devices, operators, enrolment,
 * templates, match review and consent) because these three read different
 * relations for different reasons, and each reason is a schema fact worth
 * writing down once:
 *
 *  1. ABUSE reads `public.attendance_punches` — the BASE TABLE, not
 *     `v_attendance_punch_detail`. The view's `ordered` CTE filters
 *     `WHERE NOT p.is_voided` and its own COMMENT says so ("Voided punches are
 *     excluded … from this view"), so the Punch Log physically cannot show a
 *     void. The abuse queue is ABOUT the voids, so it reads the table, which
 *     migration 016 grants SELECT to `authenticated` behind
 *     `attendance_punches__admin_read` (`app.is_admin() AND
 *     app.admin_scope_covers(employee_id)`).
 *  2. `void_reason` is free text with a ≥10-character CHECK, not an enum, and
 *     the deployed `void-punch` function writes `"<code>: <sentence>"`
 *     (`const voidReason = \`${body.voidReasonCode}: ${body.reason.trim()}\``).
 *     The code is therefore a real PREFIX, and `ilike('void_reason',
 *     'spoof_rejected:%')` is an exact server-side bucket rather than a guess.
 *     Nothing here re-classifies a punch: the machine already filed it.
 *  3. POLICY reads the nine `settings` rows of group `kiosk` (seed 046) plus
 *     each device's own `min_match_confidence`. `kiosk.min_confidence`,
 *     `kiosk.min_margin` and `kiosk.require_liveness` all carry
 *     `is_editable_by_admin = false`, so they are super-admin writes — the row
 *     itself says so and the screen disables the control instead of letting RLS
 *     refuse after the reason was typed.
 *  4. PURGE calls `face-template-admin` op `purge`. That op requires
 *     `super_admin` AND `biometric.template.purge` WITH an MFA step-up, a reason
 *     of ≥20 characters, and `confirm_employee_code` equal to the employee's
 *     code — the server refuses a mismatch with `PURGE_CONFIRMATION_MISMATCH`.
 *     It zeroes the live descriptor, zeroes the archived descriptors in
 *     `secure.face_template_history`, drops the capture objects, clears
 *     `employees.face_enrolled_at` and cancels pending enrolment requests. There
 *     is no undo, and no client role can read a descriptor either way.
 */
import { z } from "zod";
import {
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
  ilike,
  isFalse,
  isTrue,
  lte,
  selectCount,
  selectMany,
  type Filter,
} from "@/shared/api/query";
import { invokeEdgeFn } from "@/shared/api/invoke";
import { voidReasonCodes, type VoidReasonCode } from "./attendance.api";
import type { KioskDevice, Setting } from "./system.api";
import { FACE_TEMPLATE_ADMIN_FN } from "./kiosk.api";

export const ATTENDANCE_PUNCHES_TABLE = "attendance_punches";

// -----------------------------------------------------------------------------
// 1. Abuse review queue (`/admin/kiosk/abuse`) — spec-admin §5.9
// -----------------------------------------------------------------------------

/**
 * One scan as the abuse queue needs it. The projection is deliberately narrow:
 * `photo_path`, `lat`/`lng`, `ip` and `user_agent` are on the row and are NOT
 * read here — a frame is a 60-second audited reveal (§5.10) and a grid does not
 * need one to show that a scan was refused.
 */
export const abusePunchSchema = z.object({
  id: dbUuid,
  employee_id: dbUuid,
  punched_at: dbTimestamp,
  ist_date: dbDate,
  effective_date: dbDate,
  source: z.string(),
  kiosk_device_id: dbUuidNullable,
  operator_id: dbUuidNullable,
  /** Pinned by the engine at decision time; never re-compared here. */
  match_confidence: dbNumericNullable,
  needs_review: z.boolean(),
  is_offline_replay: z.boolean(),
  device_clock_skew_seconds: dbIntNullable,
  is_voided: z.boolean(),
  voided_at: dbTimestampNullable,
  /** `"<code>: <sentence>"` as written by `void-punch`. Split, never re-derive. */
  void_reason: z.string().nullable(),
  duplicate_of_punch_id: dbUuidNullable,
  operator_note: z.string().nullable(),
  reason: z.string().nullable(),
});
export type AbusePunch = z.infer<typeof abusePunchSchema>;

const ABUSE_COLUMNS = [
  "id",
  "employee_id",
  "punched_at",
  "ist_date",
  "effective_date",
  "source",
  "kiosk_device_id",
  "operator_id",
  "match_confidence",
  "needs_review",
  "is_offline_replay",
  "device_clock_skew_seconds",
  "is_voided",
  "voided_at",
  "void_reason",
  "duplicate_of_punch_id",
  "operator_note",
  "reason",
].join(",");

/**
 * The five things a human actually reviews after a day at the gate. Each one is
 * a SINGLE server-side predicate — no bucket is assembled in the browser, so the
 * tab's count and the tab's rows are answers to the same question (DR-29).
 *
 *  * `flagged`        — the gate wrote the punch and asked for a human
 *                       (`needs_review`), and nobody has decided yet.
 *  * `spoof`          — already voided as `spoof_rejected`: a presentation
 *                       attack, or an admin filing one.
 *  * `duplicate`      — voided as `debounce`: the same person inside the
 *                       duplicate window (`kiosk.debounce_seconds`).
 *  * `day_limit`      — voided as `rate_limit_day`: beyond the accepted-scans
 *                       ceiling for one employee-day.
 *  * `guard_assisted` — `source = 'kiosk_manual'`, the guard punched on the
 *                       employee's behalf. §5.9 wants this watched: it is the
 *                       one path a buddy-punch can take without a face.
 */
export const abuseBuckets = ["flagged", "spoof", "duplicate", "day_limit", "guard_assisted"] as const;
export type AbuseBucket = (typeof abuseBuckets)[number];

export interface AbuseFilters {
  readonly bucket: AbuseBucket;
  /** Inclusive IST business dates — `effective_date`, as the Punch Log filters. */
  readonly from: string;
  readonly to: string;
}

/**
 * ONE predicate builder, shared by the rows read and by `selectCount`. The void
 * codes are matched as the documented `"<code>: "` prefix rather than by
 * equality, because the column also carries the human sentence.
 */
function abuseFilters(f: AbuseFilters): Filter[] {
  const filters: Filter[] = [gte("effective_date", f.from), lte("effective_date", f.to)];
  switch (f.bucket) {
    case "flagged":
      filters.push(isTrue("needs_review"), isFalse("is_voided"));
      break;
    case "spoof":
      filters.push(ilike("void_reason", "spoof_rejected:%"));
      break;
    case "duplicate":
      filters.push(ilike("void_reason", "debounce:%"));
      break;
    case "day_limit":
      filters.push(ilike("void_reason", "rate_limit_day:%"));
      break;
    case "guard_assisted":
      filters.push(eq("source", "kiosk_manual"));
      break;
  }
  return filters;
}

export function fetchAbusePunches(
  f: AbuseFilters,
  limit = 200,
  signal?: AbortSignal,
): Promise<AbusePunch[]> {
  return selectMany(ATTENDANCE_PUNCHES_TABLE, abusePunchSchema, {
    filters: abuseFilters(f),
    order: [{ column: "punched_at", ascending: false }],
    columns: ABUSE_COLUMNS,
    limit,
    ...(signal ? { signal } : {}),
  });
}

export type AbuseSignalCounts = Readonly<Record<AbuseBucket, number>>;

/**
 * Every tab's total, counted by Postgres over the SAME predicates the rows use.
 * One query returning five `count=exact` HEADs rather than five hooks: the tiles
 * must agree with each other and with the grid, and a hook per bucket would also
 * be a hook inside a loop.
 */
export async function fetchAbuseSignalCounts(
  range: { from: string; to: string },
  signal?: AbortSignal,
): Promise<AbuseSignalCounts> {
  const [flagged, spoof, duplicate, dayLimit, guardAssisted] = await Promise.all(
    abuseBuckets.map((bucket) =>
      selectCount(ATTENDANCE_PUNCHES_TABLE, abuseFilters({ bucket, ...range }), {
        ...(signal ? { signal } : {}),
      }),
    ),
  );
  return {
    flagged: flagged ?? 0,
    spoof: spoof ?? 0,
    duplicate: duplicate ?? 0,
    day_limit: dayLimit ?? 0,
    guard_assisted: guardAssisted ?? 0,
  };
}

export interface SplitVoidReason {
  /** The machine code, when the text carries one of the six deployed prefixes. */
  readonly code: VoidReasonCode | null;
  /** The human half of the sentence, or the whole string when there is no code. */
  readonly text: string | null;
}

/**
 * Split `"spoof_rejected: guard reported a phone screen at the gate"` into its
 * code and its sentence. A string that does not carry a known prefix is returned
 * whole — an older or hand-written void is shown as written rather than
 * force-fitted into a vocabulary it never used.
 */
export function splitVoidReason(voidReason: string | null): SplitVoidReason {
  if (voidReason === null) return { code: null, text: null };
  const separator = voidReason.indexOf(":");
  if (separator > 0) {
    const candidate = voidReason.slice(0, separator).trim();
    const known = voidReasonCodes.find((code) => code === candidate);
    if (known !== undefined) {
      const rest = voidReason.slice(separator + 1).trim();
      return { code: known, text: rest === "" ? null : rest };
    }
  }
  const whole = voidReason.trim();
  return { code: null, text: whole === "" ? null : whole };
}

/**
 * The flags the gate itself set on a scan, as a presentation vocabulary. This is
 * a mapping over columns that already exist — exactly what `deviceState()` in
 * `kiosk.api.ts` is — not a new judgement about the punch: `needs_review` was
 * decided by `kiosk-punch`, `duplicate_of_punch_id` by its debounce step, and
 * the skew by the device's own clock report.
 */
export const abuseSignals = [
  "needs_review",
  "duplicate_link",
  "guard_assisted",
  "offline_replay",
  "clock_skew",
] as const;
export type AbuseSignal = (typeof abuseSignals)[number];

/** §5.11: skew beyond 90 s degrades a device and flags the punches it wrote. */
export const CLOCK_SKEW_FLAG_SECONDS = 90;

export function punchSignals(row: AbusePunch): readonly AbuseSignal[] {
  const out: AbuseSignal[] = [];
  if (row.needs_review) out.push("needs_review");
  if (row.duplicate_of_punch_id !== null) out.push("duplicate_link");
  if (row.source === "kiosk_manual") out.push("guard_assisted");
  if (row.is_offline_replay) out.push("offline_replay");
  const skew = row.device_clock_skew_seconds;
  if (skew !== null && Math.abs(skew) > CLOCK_SKEW_FLAG_SECONDS) out.push("clock_skew");
  return out;
}

// -----------------------------------------------------------------------------
// 2. Matching & liveness policy (`/admin/kiosk/policy`) — spec-admin §5.9
// -----------------------------------------------------------------------------

/**
 * The `settings` keys seed 046 created in group `kiosk`, named once so a screen
 * cannot ask for `kiosk.min_confidence` and get a silent `undefined` from a typo.
 */
export const KIOSK_SETTING_KEYS = {
  minConfidence: "kiosk.min_confidence",
  minMargin: "kiosk.min_margin",
  requireLiveness: "kiosk.require_liveness",
  debounceSeconds: "kiosk.debounce_seconds",
  offlineQueueMax: "kiosk.offline_queue_max",
  heartbeatSeconds: "kiosk.heartbeat_interval_seconds",
  offlineAlertMinutes: "kiosk.offline_alert_minutes",
  photoRetentionDays: "kiosk.retain_punch_photos_days",
  photoUrlTtlSeconds: "kiosk.punch_photo_url_ttl_seconds",
} as const;

export function findSetting(rows: readonly Setting[], key: string): Setting | null {
  return rows.find((row) => row.key === key) ?? null;
}

/**
 * A `number`-kind jsonb value, or null when the row is absent or holds something
 * else. NO coercion: a string "0.62" is reported as missing rather than quietly
 * turned into a threshold, because a threshold read wrong is a gate that lets in
 * the wrong person.
 */
export function settingNumber(rows: readonly Setting[], key: string): number | null {
  const value = findSetting(rows, key)?.value;
  return typeof value === "number" ? value : null;
}

export function settingBoolean(rows: readonly Setting[], key: string): boolean | null {
  const value = findSetting(rows, key)?.value;
  return typeof value === "boolean" ? value : null;
}

/**
 * How one gate's own accept floor sits against the company floor. A device with
 * a LOOSER floor accepts faces the policy would have sent to the guard, so it is
 * the case the screen must surface — hence a named state rather than two numbers
 * side by side.
 */
export type DeviceFloorState = "unset" | "matches" | "stricter" | "looser" | "unknown";

export function deviceFloorState(device: KioskDevice, globalFloor: number | null): DeviceFloorState {
  if (device.min_match_confidence === null) return "unset";
  if (globalFloor === null) return "unknown";
  if (device.min_match_confidence === globalFloor) return "matches";
  return device.min_match_confidence > globalFloor ? "stricter" : "looser";
}

// -----------------------------------------------------------------------------
// 3. Template purge (`/admin/kiosk/purge`) — spec-admin §5.10, DPDP erasure
// -----------------------------------------------------------------------------

/** `PurgeOp.reason` is `min(20)` server-side; the client refuses shorter. */
export const PURGE_REASON_MIN_LENGTH = 20;

/**
 * The lawful grounds this venue can actually cite for destroying a biometric,
 * from spec-admin §2.9 (legal basis on an erasure) and §13.4 (retention class
 * `biometric_exit_plus_30d`). The chosen code is written as a PREFIX on the
 * audited reason — the same trick `void-punch` uses, so `purge_biometric` rows
 * stay greppable in the hash chain without a migration.
 */
export const purgeLegalBases = [
  "dpdp_erasure_request",
  "exit_retention_elapsed",
  "enrolled_in_error",
] as const;
export type PurgeLegalBasis = (typeof purgeLegalBases)[number];

export interface PurgeReasonParts {
  readonly basis: PurgeLegalBasis;
  /** What the super admin typed: the request or incident, in their own words. */
  readonly typed: string;
  /** The second super admin who authorised it — §16 four-eyes, in the record. */
  readonly counterSignerName: string;
}

/**
 * Assemble the sentence that lands in `audit_log.reason` and in
 * `data_access_log.purpose`.
 *
 * The counter-signer's name is part of the REASON on purpose: no deployed
 * endpoint takes a second approver for a purge, so the only place a second pair
 * of eyes can be recorded is the immutable audit row. Putting it anywhere else
 * would be a claim the database cannot back up.
 */
export function purgeReason(parts: PurgeReasonParts): string {
  return `${parts.basis}: ${parts.typed.trim()} — counter-authorised by ${parts.counterSignerName.trim()}`;
}

export const purgeResultSchema = z.object({
  op: z.literal("purge"),
  scope: z.enum(["template", "employee"]),
  employeeId: dbUuid,
  employeeCode: z.string(),
  displayName: z.string().nullable(),
  purgedTemplateIds: z.array(dbUuid),
  purgedVersions: z.array(dbInt),
  purgedCount: dbInt,
  /** `secure.face_template_history` rows whose descriptor was zeroed too. */
  archiveRowsZeroed: dbInt,
  captureObjects: dbInt,
  /** False → storage objects survived the transaction and need a sweep. */
  capturesRemoved: z.boolean(),
  faceEnrolledAtCleared: z.boolean(),
  irreversible: z.literal(true),
});
export type PurgeResult = z.infer<typeof purgeResultSchema>;

export interface PurgeInput {
  /** `employee` destroys every version; `template` destroys one version. */
  readonly scope: "employee" | "template";
  readonly employeeId: string;
  readonly templateId?: string;
  /** Must equal `employees.employee_code` exactly, or the server refuses (T-19). */
  readonly confirmEmployeeCode: string;
  /** Minted when the confirm panel opens and reused on the step-up retry. */
  readonly idempotencyKey: string;
}

/**
 * Destroy biometric material. Super-admin only, MFA step-up enforced by the
 * function, and every call writes both a `purge_biometric` audit row and a
 * `data_access_log` row for the subject before it returns.
 *
 * `scope: 'employee'` sends no `template_id` at all: the op's own validation
 * refuses `employee` scope with one, and sending both would let a UI bug destroy
 * more than the confirmation named.
 */
export function purgeFaceTemplates(
  input: PurgeInput,
  reason: string,
  signal?: AbortSignal,
): Promise<PurgeResult> {
  return invokeEdgeFn(
    FACE_TEMPLATE_ADMIN_FN,
    {
      op: "purge",
      scope: input.scope,
      ...(input.scope === "template" ? { template_id: input.templateId } : {}),
      ...(input.scope === "employee" ? { employee_id: input.employeeId } : {}),
      confirm_employee_code: input.confirmEmployeeCode,
      reason,
    },
    purgeResultSchema,
    { idempotencyKey: input.idempotencyKey, ...(signal ? { signal } : {}) },
  );
}
