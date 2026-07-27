/**
 * _shared/audit.ts — explicit audit rows for the events no table trigger can see.
 *
 * Most writes need NOTHING from this module: `audit.log_changes()` is attached to
 * every audited table (migration 038) and emits one hash-chained
 * `public.audit_log` row per changed field automatically, reading the actor from
 * the `app.*` context that `db.withContext()` set. Do not double-log those.
 *
 * This module is for the events that are not a row change:
 *   login / logout / login_failed        `auditSession`
 *   export produced                      `auditExport`      (+ `public.export_log`)
 *   sensitive value revealed, AI query   `auditDataAccess`  (+ `public.data_access_log`)
 *   job run outcome                      `auditJobRun`
 *   anything else                        `writeAudit`
 *
 * WRITE PATH (from migration 006, verified): rows go in through
 * `SELECT audit.write_row(...)` — a SECURITY DEFINER function that takes an
 * advisory lock, extends `audit.chain_state` (`row_hash = sha256(prev_hash ||
 * canonical payload)`), inserts, then stores the new head. NEVER
 * `INSERT INTO public.audit_log` directly: a direct insert would have no
 * `prev_hash`, would not advance the chain, and `audit.verify_chain()` would
 * report the log as tampered. `audit.write_row` also reads
 * `app.ctx('source_route')` for `audit_log.source`, so it must be called INSIDE
 * the `withContext()` transaction that set it.
 *
 * `public.audit_log`, `data_access_log`, `export_log` and `sessions_audit` are
 * insert-only for every role including super_admin (`audit.refuse_mutation`).
 * A correction is a new row, never an edit.
 */

import type { Sql } from "./deps.ts";
import { type RequestContext, sql as sqlHandle } from "./db.ts";

/** `public.audit_action` (migration 003). */
export type AuditAction =
  | "insert"
  | "update"
  | "delete"
  | "soft_delete"
  | "restore"
  | "hard_delete"
  | "login"
  | "logout"
  | "login_failed"
  | "read_sensitive"
  | "export"
  | "approve"
  | "reject"
  | "cancel"
  | "void"
  | "override"
  | "recompute"
  | "lock"
  | "unlock"
  | "send"
  | "sign"
  | "enrol_biometric"
  | "purge_biometric"
  | "grant_role"
  | "revoke_role"
  | "impersonate"
  | "config_change"
  | "job_run";

export interface AuditEvent {
  action: AuditAction;
  /** Schema-qualified, e.g. `public.attendance_punches`. Matches `audit_log.entity_table`. */
  entityTable: string;
  entityId?: string | null;
  /** Human label; `audit.entity_label()` does this for trigger rows. ≤200 chars. */
  entityLabel?: string | null;
  /** Whose data this is about — drives the employee-facing "my audit trail". */
  subjectEmployeeId?: string | null;
  fieldName?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  isRedacted?: boolean;
  /** Overrides `ctx.reason` for this row only. */
  reason?: string | null;
}

function toJsonbParam(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value ?? null);
}

/**
 * Write one audit row through the hash chain.
 *
 * Actor identity (email, employee id, role) is resolved IN the statement from
 * `ctx.actorId`, so the row is self-describing even years later, and a NULL
 * actor (kiosk, cron) still produces a row — the `LEFT JOIN` from a one-row
 * seed makes sure of it.
 *
 * Must run inside `withContext()` — same transaction as the change it describes
 * (lifecycle step 10), so a rollback loses both or neither.
 */
export async function writeAudit(
  client: Sql,
  ctx: RequestContext,
  event: AuditEvent,
): Promise<void> {
  const reason = (event.reason ?? ctx.reason ?? null);
  await client`
    SELECT audit.write_row(
             ${event.action}::public.audit_action,
             ${event.entityTable}::text,
             ${event.entityId ?? null}::uuid,
             ${event.entityLabel ?? null}::text,
             ${event.subjectEmployeeId ?? null}::uuid,
             ${event.fieldName ?? null}::text,
             ${toJsonbParam(event.oldValue)}::jsonb,
             ${toJsonbParam(event.newValue)}::jsonb,
             ${event.isRedacted === true}::boolean,
             ${reason}::text,
             a.actor_id,
             a.employee_id,
             a.email,
             a.role,
             ${ctx.source}::public.actor_source,
             ${ctx.onBehalfOf ?? null}::uuid,
             ${ctx.impersonatedBy ?? null}::uuid,
             ${ctx.approvalRequestId ?? null}::uuid,
             ${ctx.requestId}::uuid,
             ${ctx.ip ?? null}::inet,
             ${ctx.ua ?? null}::text,
             ${ctx.deviceId ?? null}::text
           )
      FROM (
        SELECT k.aid                     AS actor_id,
               e.id                      AS employee_id,
               p.email                   AS email,
               (SELECT CASE
                         WHEN bool_or(ur.role = 'super_admin') THEN 'super_admin'
                         WHEN bool_or(ur.role = 'admin')       THEN 'admin'
                         WHEN bool_or(ur.role = 'manager')     THEN 'manager'
                         WHEN count(*) > 0                     THEN 'employee'
                       END
                  FROM public.user_roles ur
                 WHERE ur.user_id = k.aid AND ur.revoked_at IS NULL
               )::public.app_role        AS role
          FROM (SELECT ${ctx.actorId ?? null}::uuid AS aid) k
          LEFT JOIN public.profiles  p ON p.id = k.aid
          LEFT JOIN public.employees e ON e.profile_id = k.aid AND e.deleted_at IS NULL
      ) a
  `;
}

// ── Session events (login / logout / failure) ───────────────────────────────

/**
 * `ck_sessions_audit__event` (migration 004), unchanged. A face sign-in is a
 * `login_success` with `auth_method = 'face'` and has no event of its own — see
 * the reasoning in 20260801012200_face_login_auth_channel.sql.
 */
export type SessionEvent =
  | "login_success"
  | "login_failed"
  | "logout"
  | "token_refresh"
  | "password_reset_requested"
  | "password_changed"
  | "passkey_registered"
  | "passkey_used"
  | "mfa_challenge"
  | "session_revoked";

/** `ck_sessions_audit__auth_method`; `face` added by 20260801012200 (`face-login`). */
export type AuthMethod = "password" | "passkey" | "magic_link" | "otp" | "kiosk_pin" | "face";

const SESSION_TO_AUDIT_ACTION: Partial<Record<SessionEvent, AuditAction>> = {
  login_success: "login",
  login_failed: "login_failed",
  logout: "logout",
  session_revoked: "logout",
};

/**
 * Records a session event in `public.sessions_audit` and, for the three that
 * matter to the audit trail (login / login_failed / logout), also on the hash
 * chain. `attempted_email` must be lowercase (`ck_sessions_audit__attempted_email_lower`).
 */
export async function auditSession(
  client: Sql,
  ctx: RequestContext,
  input: {
    event: SessionEvent;
    profileId?: string | null;
    attemptedEmail?: string | null;
    authMethod?: AuthMethod | null;
    failureReason?: string | null;
  },
): Promise<void> {
  await client`
    INSERT INTO public.sessions_audit
      (profile_id, attempted_email, event, auth_method, ip, user_agent, device_id, failure_reason)
    VALUES (
      ${input.profileId ?? null}::uuid,
      ${input.attemptedEmail === null || input.attemptedEmail === undefined
        ? null
        : input.attemptedEmail.trim().toLowerCase()}::text,
      ${input.event}::text,
      ${input.authMethod ?? null}::text,
      ${ctx.ip ?? null}::inet,
      ${ctx.ua ?? null}::text,
      ${ctx.deviceId ?? null}::text,
      ${input.failureReason ?? null}::text
    )
  `;

  const action = SESSION_TO_AUDIT_ACTION[input.event];
  if (action !== undefined) {
    await writeAudit(client, ctx, {
      action,
      entityTable: "public.profiles",
      entityId: input.profileId ?? null,
      entityLabel: input.attemptedEmail?.toLowerCase() ?? null,
      reason: ctx.reason ?? `${input.event} via ${input.authMethod ?? "unknown"}`,
    });
  }
}

// ── Data access (reveal / export / report / ai_query / bulk_view) ────────────

export type AccessKind = "reveal" | "export" | "report" | "ai_query" | "bulk_view";

/**
 * `public.data_access_log` + a `read_sensitive` chain row.
 *
 * §6: the reveal endpoint writes this BEFORE returning the value, and a bulk
 * reveal writes ONE ROW PER EMPLOYEE — call this per subject, not once per batch.
 * `purpose` must be ≥10 characters (`ck_dalog__purpose`).
 */
export async function auditDataAccess(
  client: Sql,
  ctx: RequestContext,
  input: {
    accessKind: AccessKind;
    entityTable: string;
    entityId?: string | null;
    subjectEmployeeId?: string | null;
    fields: string[];
    purpose: string;
    recordCount?: number | null;
    filterSummary?: unknown;
  },
): Promise<void> {
  await client`
    INSERT INTO public.data_access_log
      (actor_id, actor_role, actor_source, on_behalf_of, entity_table, entity_id,
       subject_employee_id, fields, access_kind, purpose, record_count, filter_summary,
       ip, user_agent, device_id, request_id)
    VALUES (
      ${ctx.actorId ?? null}::uuid,
      ${ctx.actorRole ?? null}::public.app_role,
      ${ctx.source}::public.actor_source,
      ${ctx.onBehalfOf ?? null}::uuid,
      ${input.entityTable}::text,
      ${input.entityId ?? null}::uuid,
      ${input.subjectEmployeeId ?? null}::uuid,
      ${input.fields}::text[],
      ${input.accessKind}::text,
      ${input.purpose}::text,
      ${input.recordCount ?? null}::integer,
      ${toJsonbParam(input.filterSummary)}::jsonb,
      ${ctx.ip ?? null}::inet,
      ${ctx.ua ?? null}::text,
      ${ctx.deviceId ?? null}::text,
      ${ctx.requestId}::uuid
    )
  `;

  await writeAudit(client, ctx, {
    action: "read_sensitive",
    entityTable: input.entityTable,
    entityId: input.entityId ?? null,
    subjectEmployeeId: input.subjectEmployeeId ?? null,
    newValue: { access_kind: input.accessKind, fields: input.fields },
    isRedacted: true,
    reason: input.purpose,
  });
}

// ── Exports ─────────────────────────────────────────────────────────────────

export type ExportKind = "csv" | "xlsx" | "pdf" | "bank_advice" | "audit_dump" | "api_bulk" | "ai_infographic_data";
export type ExportSubject =
  | "employees"
  | "attendance"
  | "payroll"
  | "audit_log"
  | "documents"
  | "leave"
  | "assets"
  | "face_match_log";

/**
 * `public.export_log` + an `export` chain row. Returns the export row id, which
 * belongs in the response so the file can be traced back.
 *
 * `ck_export_log__approval`: when the export contains salary OR more than 500
 * rows, `approvedBy` is REQUIRED or the insert fails.
 */
export async function auditExport(
  client: Sql,
  ctx: RequestContext,
  input: {
    exportKind: ExportKind;
    subject: ExportSubject;
    purpose: string;
    filters?: unknown;
    columns?: string[];
    rowCount?: number | null;
    fileSizeBytes?: number | null;
    containsPii?: boolean;
    containsSalary?: boolean;
    containsBiometric?: boolean;
    storagePath?: string | null;
    checksumSha256?: string | null;
    approvedBy?: string | null;
  },
): Promise<string> {
  const rows = await client`
    INSERT INTO public.export_log
      (actor_id, actor_role, export_kind, subject, filters, columns, row_count,
       file_size_bytes, contains_pii, contains_salary, contains_biometric,
       storage_path, checksum_sha256, purpose, approved_by, ip, user_agent, request_id)
    VALUES (
      ${ctx.actorId ?? null}::uuid,
      ${ctx.actorRole ?? null}::public.app_role,
      ${input.exportKind}::text,
      ${input.subject}::text,
      ${toJsonbParam(input.filters)}::jsonb,
      ${input.columns ?? null}::text[],
      ${input.rowCount ?? null}::integer,
      ${input.fileSizeBytes ?? null}::bigint,
      ${input.containsPii === true}::boolean,
      ${input.containsSalary === true}::boolean,
      ${input.containsBiometric === true}::boolean,
      ${input.storagePath ?? null}::text,
      ${input.checksumSha256 ?? null}::text,
      ${input.purpose}::text,
      ${input.approvedBy ?? null}::uuid,
      ${ctx.ip ?? null}::inet,
      ${ctx.ua ?? null}::text,
      ${ctx.requestId}::uuid
    )
    RETURNING id
  `;
  const id = (rows as unknown as { id: string }[])[0]?.id as string;

  await writeAudit(client, ctx, {
    action: "export",
    entityTable: "public.export_log",
    entityId: id,
    entityLabel: `${input.exportKind}:${input.subject}`,
    newValue: {
      subject: input.subject,
      row_count: input.rowCount ?? null,
      checksum_sha256: input.checksumSha256 ?? null,
    },
    reason: input.purpose,
  });
  return id;
}

// ── Job runs (cron) ─────────────────────────────────────────────────────────

/**
 * A `job_run` chain row for a cron function. `public.job_runs` itself is written
 * by `app.job_begin`/`app.job_end` (migration 031) and is deliberately NOT
 * trigger-audited, so this is how a scheduled job appears in the audit trail.
 */
export async function auditJobRun(
  client: Sql,
  ctx: RequestContext,
  input: { jobCode: string; runId?: string | null; outcome: string; stats?: unknown },
): Promise<void> {
  await writeAudit(client, ctx, {
    action: "job_run",
    entityTable: "public.job_runs",
    entityId: input.runId ?? null,
    entityLabel: input.jobCode,
    newValue: { outcome: input.outcome, ...(input.stats === undefined ? {} : { stats: input.stats }) },
    reason: ctx.reason ?? `scheduled job ${input.jobCode}: ${input.outcome}`,
  });
}

/**
 * Escape hatch for a one-off audit row written outside a business transaction
 * (for example from a `catch` that must record a refusal). Prefer passing the
 * transaction handle to `writeAudit`.
 */
export function writeAuditOnPool(ctx: RequestContext, event: AuditEvent): Promise<void> {
  return writeAudit(sqlHandle(), ctx, event);
}
