/**
 * scheduled-reports.api.ts — the recurring-report register.
 *
 * `/admin/analytics/scheduled` listed three missing pieces by name rather than
 * offering a form over nothing: `scheduled_reports`, `scheduled_report_recipients`
 * and a `report-render` function. Migration 043400 built the first two.
 *
 * ── THE THIRD IS STILL MISSING, AND THIS MODULE SAYS SO ─────────────────────
 *
 * Nothing renders or delivers a report. Recording a schedule writes down a
 * decision — "the muster goes to the GM every Monday" — which is worth having,
 * because a schedule that lives in one person's head is lost when they take a
 * week off. It is not delivery, and `last_dispatched_at` is read rather than
 * assumed so the screen can say which schedules have never gone out.
 *
 * That column is the honest half of this feature. An enabled schedule with a
 * NULL dispatch instant is not "working" — it is a note.
 */
import { z } from "zod";
import {
  dbInt,
  dbTimestamp,
  dbTimestampNullable,
  dbUuid,
  dbUuidNullable,
  eq,
  isNull,
  selectMany,
} from "@/shared/api/query";
import { insertOne, updateOne } from "@/shared/api/write";

export const SCHEDULED_REPORTS_TABLE = "scheduled_reports";
export const SCHEDULED_REPORT_RECIPIENTS_TABLE = "scheduled_report_recipients";
export const SCHEDULED_REPORTS_DUE_VIEW = "v_scheduled_reports_due";

/** `ck_schedrep__subject` — every value names a relation that already exists. */
export const reportSubjectValues = [
  "attendance_muster",
  "attendance_exceptions",
  "leave_balances",
  "leave_taken",
  "payroll_register",
  "payroll_statutory",
  "document_compliance",
  "asset_custody",
  "approvals_pending",
  "headcount",
] as const;
export type ReportSubject = (typeof reportSubjectValues)[number];

/** `ck_schedrep__format`. */
export const reportFormatValues = ["csv", "xlsx", "pdf"] as const;
export type ReportFormat = (typeof reportFormatValues)[number];

/**
 * The handful of cadences a venue actually asks for, with their cron.
 *
 * Offered as a picker rather than a cron text box. `schedule_human` is STORED
 * alongside the expression precisely so nobody has to read `0 7 * * 1` back — and
 * a browser that renders cron into English would be a second implementation of a
 * thing the author already knew when they chose it.
 */
export const SCHEDULE_PRESETS = [
  { key: "daily_7am", cron: "0 7 * * *", human: "Every day at 7:00 am" },
  { key: "weekly_mon_7am", cron: "0 7 * * 1", human: "Every Monday at 7:00 am" },
  { key: "weekly_fri_5pm", cron: "0 17 * * 5", human: "Every Friday at 5:00 pm" },
  { key: "monthly_1st_7am", cron: "0 7 1 * *", human: "On the 1st of each month at 7:00 am" },
  { key: "monthly_last_5pm", cron: "0 17 28-31 * *", human: "At the end of each month" },
] as const;
export type SchedulePresetKey = (typeof SCHEDULE_PRESETS)[number]["key"];

export const scheduledReportSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  subject: z.string(),
  format: z.string(),
  schedule_cron: z.string(),
  schedule_human: z.string(),
  timezone: z.string(),
  is_enabled: z.boolean(),
  last_dispatched_at: dbTimestampNullable,
  last_dispatch_note: z.string().nullable(),
  next_run_at: dbTimestampNullable,
  created_at: dbTimestamp,
});
export type ScheduledReport = z.infer<typeof scheduledReportSchema>;

export const scheduledReportRecipientSchema = z.object({
  id: dbUuid,
  scheduled_report_id: dbUuid,
  employee_id: dbUuidNullable,
  email: z.string().nullable(),
});
export type ScheduledReportRecipient = z.infer<typeof scheduledReportRecipientSchema>;

/** `v_scheduled_reports_due` — the predicate a dispatcher would run. */
export const scheduledReportDueSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  subject: z.string(),
  schedule_human: z.string(),
  next_run_at: dbTimestampNullable,
  last_dispatched_at: dbTimestampNullable,
  recipient_count: dbInt,
  is_due: z.boolean(),
  never_dispatched: z.boolean(),
});
export type ScheduledReportDue = z.infer<typeof scheduledReportDueSchema>;

const REPORT_COLUMNS =
  "id, code, name, description, subject, format, schedule_cron, schedule_human, " +
  "timezone, is_enabled, last_dispatched_at, last_dispatch_note, next_run_at, created_at";

export function fetchScheduledReports(signal?: AbortSignal): Promise<ScheduledReport[]> {
  return selectMany(SCHEDULED_REPORTS_TABLE, scheduledReportSchema, {
    columns: REPORT_COLUMNS,
    filters: [isNull("deleted_at")],
    order: [{ column: "name", ascending: true }],
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

/** Enabled schedules with their recipient count and whether anything has sent one. */
export function fetchScheduledReportsDue(
  signal?: AbortSignal,
): Promise<ScheduledReportDue[]> {
  return selectMany(SCHEDULED_REPORTS_DUE_VIEW, scheduledReportDueSchema, {
    order: [{ column: "name", ascending: true }],
    limit: 200,
    ...(signal ? { signal } : {}),
  });
}

export function fetchRecipients(
  reportId: string,
  signal?: AbortSignal,
): Promise<ScheduledReportRecipient[]> {
  return selectMany(SCHEDULED_REPORT_RECIPIENTS_TABLE, scheduledReportRecipientSchema, {
    filters: [eq("scheduled_report_id", reportId)],
    limit: 100,
    ...(signal ? { signal } : {}),
  });
}

export interface CreateScheduledReportInput {
  readonly companyId: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly subject: ReportSubject;
  readonly format: ReportFormat;
  readonly scheduleCron: string;
  readonly scheduleHuman: string;
}

/**
 * Record a schedule.
 *
 * `next_run_at` is deliberately NOT set here. Computing the next occurrence of a
 * cron expression in a browser means implementing cron, in the client's timezone,
 * against a schedule that is stored in IST — and the figure would then be read as
 * a promise that something will fire at it. Whatever eventually dispatches these
 * owns that column; until then it stays NULL and the screen says "not scheduled
 * to run" rather than inventing a date.
 */
export function createScheduledReport(
  input: CreateScheduledReportInput,
  signal?: AbortSignal,
): Promise<ScheduledReport> {
  return insertOne(
    SCHEDULED_REPORTS_TABLE,
    scheduledReportSchema,
    {
      company_id: input.companyId,
      code: input.code.trim().toUpperCase(),
      name: input.name.trim(),
      description: input.description === null ? null : input.description.trim(),
      subject: input.subject,
      format: input.format,
      schedule_cron: input.scheduleCron,
      schedule_human: input.scheduleHuman,
      is_enabled: true,
    },
    { columns: REPORT_COLUMNS, ...(signal ? { signal } : {}) },
  );
}

/** Turn one on or off. Disabling keeps the row — and its recipients. */
export function setScheduleEnabled(
  reportId: string,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<ScheduledReport> {
  return updateOne(
    SCHEDULED_REPORTS_TABLE,
    scheduledReportSchema,
    { is_enabled: enabled },
    { id: reportId },
    { columns: REPORT_COLUMNS, ...(signal ? { signal } : {}) },
  );
}

export interface AddRecipientInput {
  readonly reportId: string;
  /** Exactly one of these — `ck_schedrec__one_of` refuses both and neither. */
  readonly employeeId: string | null;
  readonly email: string | null;
}

export function addRecipient(
  input: AddRecipientInput,
  signal?: AbortSignal,
): Promise<ScheduledReportRecipient> {
  return insertOne(
    SCHEDULED_REPORT_RECIPIENTS_TABLE,
    scheduledReportRecipientSchema,
    {
      scheduled_report_id: input.reportId,
      employee_id: input.employeeId,
      email: input.email === null ? null : input.email.trim().toLowerCase(),
    },
    { ...(signal ? { signal } : {}) },
  );
}
