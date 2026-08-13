/**
 * health.api.ts — `/admin/settings/health` (§15.10) and the notification-template
 * register (§15.7).
 *
 * Three tables, all admin-readable with a deployed policy:
 *   * `system_health`         — one row per component check (`ok|degraded|down|unknown`),
 *                               admin SELECT + admin UPDATE (the acknowledge path).
 *   * `job_runs`              — cron/edge job history, admin SELECT only. The console
 *                               cannot start or retry a job: `job_runs` has no INSERT
 *                               grant for `authenticated` (migration 031), by design —
 *                               a job is started by cron or by an edge function.
 *   * `notification_templates`— admin FOR ALL. `system.api.ts` models the four columns
 *                               its list needed; this module models the row the
 *                               template register actually renders (channel, locale,
 *                               subject, DLT id), read off migration 027.
 *
 * No aggregation happens here. "3 of 9 components degraded" is a count of the rows
 * the screen is already showing, which is DR-28-safe; anything the server has not
 * computed is reported as missing rather than derived.
 */
import { z } from "zod";
import {
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
  isNull,
  selectMany,
  updateRow,
  type Filter,
} from "@/shared/api/query";
import { nowInstantIso } from "@/lib/datetime";

export const SYSTEM_HEALTH_TABLE = "system_health";
export const JOB_RUNS_TABLE = "job_runs";
export const CRON_JOBS_TABLE = "cron_jobs";
export const NOTIFICATION_TEMPLATES_TABLE = "notification_templates";

export const REASON_ACK_HEALTH = "admin console: acknowledged a system health alert";
export const REASON_TEMPLATE_TOGGLE = "admin console: changed a notification template";

// -----------------------------------------------------------------------------
// 1. system_health
// -----------------------------------------------------------------------------

export const healthStatusValues = ["ok", "degraded", "down", "unknown"] as const;
export const healthStatusSchema = z.enum(healthStatusValues);
export type HealthStatus = z.infer<typeof healthStatusSchema>;

export const systemHealthSchema = z.object({
  id: dbUuid,
  checked_at: dbTimestamp,
  component: z.string(),
  status: healthStatusSchema,
  metric_name: z.string().nullable(),
  metric_value: dbNumericNullable,
  threshold: dbNumericNullable,
  detail: z.unknown().nullable(),
  message: z.string().nullable(),
  alert_sent_at: dbTimestampNullable,
  acknowledged_by: dbUuidNullable,
  acknowledged_at: dbTimestampNullable,
  resolved_at: dbTimestampNullable,
});
export type SystemHealthRow = z.infer<typeof systemHealthSchema>;

export interface HealthFilters {
  /** Only checks still open (unresolved and not `ok`) — the alert list. */
  readonly onlyOpen?: boolean;
  readonly statuses?: readonly HealthStatus[];
  /** ISO instant lower bound on `checked_at`. */
  readonly since?: string;
}

export function fetchSystemHealth(
  f: HealthFilters = {},
  limit = 300,
  signal?: AbortSignal,
): Promise<SystemHealthRow[]> {
  const filters: Filter[] = [];
  if (f.onlyOpen === true) {
    filters.push(isNull("resolved_at"));
    filters.push(inList("status", ["degraded", "down", "unknown"]));
  }
  if (f.statuses && f.statuses.length > 0) filters.push(inList("status", f.statuses));
  if (f.since !== undefined) filters.push(gte("checked_at", f.since));
  return selectMany(SYSTEM_HEALTH_TABLE, systemHealthSchema, {
    filters,
    order: [{ column: "checked_at", ascending: false }],
    limit,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Acknowledge a health alert. `system_health` is not in
 * `audit.reason_required_tables`, so the database would accept this without a
 * sentence — the helper still carries one, because "who said this alert was
 * understood, and why" is the only reason to record an acknowledgement at all.
 */
export function acknowledgeHealthAlert(
  id: string,
  profileId: string,
  reason: string,
  signal?: AbortSignal,
): Promise<SystemHealthRow> {
  return updateRow(
    SYSTEM_HEALTH_TABLE,
    [eq("id", id), isNull("acknowledged_at")],
    { acknowledged_by: profileId, acknowledged_at: nowInstantIso() },
    systemHealthSchema,
    { reason, ...(signal ? { signal } : {}) },
  );
}

// -----------------------------------------------------------------------------
// 2. job_runs
// -----------------------------------------------------------------------------

/** `public.job_run_status` (migration 003). */
export const jobRunStatusValues = ["running", "succeeded", "failed", "skipped", "cancelled"] as const;
export const jobRunStatusSchema = z.string();
export type JobRunStatus = string;

export const jobRunSchema = z.object({
  id: dbUuid,
  cron_job_id: dbUuidNullable,
  job_code: z.string(),
  /** 'scheduled' | 'manual' | 'retry' | 'backfill'. */
  run_kind: z.string(),
  status: jobRunStatusSchema,
  started_at: dbTimestamp,
  finished_at: dbTimestampNullable,
  duration_ms: dbIntNullable,
  records_processed: dbIntNullable,
  records_failed: dbIntNullable,
  error: z.string().nullable(),
  attempt: dbInt,
});
export type JobRun = z.infer<typeof jobRunSchema>;

/** Projection excludes `result`, `error_stack` and `lock_key` — internals. */
const JOB_RUN_COLUMNS = [
  "id",
  "cron_job_id",
  "job_code",
  "run_kind",
  "status",
  "started_at",
  "finished_at",
  "duration_ms",
  "records_processed",
  "records_failed",
  "error",
  "attempt",
].join(",");

export function fetchJobRuns(
  f: { jobCode?: string; since?: string } = {},
  limit = 200,
  signal?: AbortSignal,
): Promise<JobRun[]> {
  const filters: Filter[] = [];
  if (f.jobCode !== undefined && f.jobCode !== "") filters.push(eq("job_code", f.jobCode));
  if (f.since !== undefined) filters.push(gte("started_at", f.since));
  return selectMany(JOB_RUNS_TABLE, jobRunSchema, {
    filters,
    order: [{ column: "started_at", ascending: false }],
    columns: JOB_RUN_COLUMNS,
    limit,
    ...(signal ? { signal } : {}),
  });
}

/*
  `code`, NOT `job_code` — there is no such column on `cron_jobs` and never has
  been (system.sql:197). The name was guessed, and it was guessed in TWO places:
  here and in the `order` clause below, where PostgREST answers an unknown sort
  column with a 400. So this read has been failing outright, not merely parsing
  loosely.

  `settings-extra.api.ts` reads the same table correctly via `code`. Two files,
  one relation, disagreeing — the same shape as the v_approval_inbox `summary`
  defect that broke /admin/tasks.
*/
export const cronJobSchema = z
  .object({
    id: dbUuid,
    code: z.string(),
    is_enabled: z.boolean(),
  })
  .passthrough();
export type CronJob = z.infer<typeof cronJobSchema>;

/**
 * The schedule register behind the run history. The row shape beyond these three
 * columns could not be confirmed against a live read, so the rest passes through
 * rather than being guessed at.
 */
export function fetchCronJobs(signal?: AbortSignal): Promise<CronJob[]> {
  return selectMany(CRON_JOBS_TABLE, cronJobSchema, {
    order: [{ column: "code", ascending: true }],
    limit: 100,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 3. notification_templates (§15.7)
// -----------------------------------------------------------------------------

export const notificationChannelValues = ["email", "sms", "whatsapp", "in_app", "push"] as const;

export const notificationTemplateRowSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sort_order: dbInt,
  is_active: z.boolean(),
  /** `public.notification_channel` — rendered through a label map, never raw. */
  channel: z.string(),
  subject_template: z.string().nullable(),
  body_template: z.string(),
  sms_template: z.string().nullable(),
  dlt_template_id: z.string().nullable(),
  locale: z.string(),
  is_transactional: z.boolean(),
  /** Seeded rows an admin may enable/disable but should not rewrite. */
  is_system: z.boolean(),
  updated_at: dbTimestamp,
});
export type NotificationTemplateRow = z.infer<typeof notificationTemplateRowSchema>;

/** Projection excludes `body_template`'s siblings we never render in the grid. */
const TEMPLATE_COLUMNS = [
  "id",
  "code",
  "name",
  "description",
  "sort_order",
  "is_active",
  "channel",
  "subject_template",
  "body_template",
  "sms_template",
  "dlt_template_id",
  "locale",
  "is_transactional",
  "is_system",
  "updated_at",
].join(",");

export function fetchNotificationTemplateRows(
  f: { channels?: readonly string[] } = {},
  signal?: AbortSignal,
): Promise<NotificationTemplateRow[]> {
  const filters: Filter[] = [isNull("deleted_at")];
  if (f.channels && f.channels.length > 0) filters.push(inList("channel", f.channels));
  return selectMany(NOTIFICATION_TEMPLATES_TABLE, notificationTemplateRowSchema, {
    filters,
    order: [
      { column: "code", ascending: true },
      { column: "channel", ascending: true },
    ],
    columns: TEMPLATE_COLUMNS,
    limit: 400,
    ...(signal ? { signal } : {}),
  });
}

/** Enable or silence one event×channel template. */
export function setNotificationTemplateActive(
  id: string,
  isActive: boolean,
  reason: string,
  signal?: AbortSignal,
): Promise<NotificationTemplateRow> {
  return updateRow(
    NOTIFICATION_TEMPLATES_TABLE,
    [eq("id", id), isNull("deleted_at")],
    { is_active: isActive },
    notificationTemplateRowSchema,
    { reason, columns: TEMPLATE_COLUMNS, ...(signal ? { signal } : {}) },
  );
}
