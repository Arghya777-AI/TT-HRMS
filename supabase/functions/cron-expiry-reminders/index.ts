/**
 * cron-expiry-reminders — catalogue #23, auth model **C** (cron secret,
 * constant-time, or a service-role bearer for a manual run).
 *
 * One door for the eight "something is about to lapse" jobs of
 * `04-data-model.md §8.9`, selected by `?classes=` (comma-separated) exactly as
 * migration 041 sends it. Windows are §8.9 verbatim:
 *
 *   `probation`     `employees.confirmation_due_date` in {30, 15, 7, 0} days →
 *                   manager + HR. Overdue by more than 15 days ESCALATES to the
 *                   department head, re-nagging once a week, not once a day.
 *   `contract`      `employees.contract_end_date` in {60, 30, 15, 7} → HR + manager.
 *   `document`      `documents.expiry_date` against that type's OWN
 *                   `document_types.expiry_reminder_days` (default {60,30,14,7,1}) —
 *                   data-driven, so changing a type's cadence is a settings change.
 *   `identity`      `employee_identity_documents.expiry_date` (current rows only).
 *   `licence`       `employee_qualifications.licence_expiry`.
 *   `fssai`         the FSSAI subset of `document` + `licence`
 *                   (`FSSAI_CERT`; `food_safety` / `fssai_supervisor` licences).
 *   `fire_safety`   the fire-safety subset (`FIRE_SAFETY_CERT`; `fire_safety`).
 *                   §8.9: "Includes FSSAI and fire-safety certificates — a
 *                   venue-critical control."
 *   `insurance`     document types whose code/category names insurance.
 *   `compoff`       comp-off credits at −14 / −7 / −1 days.
 *   `leave_lapse`   balance above the carry-forward cap that will lapse at FY end.
 *   `celebration`   birthday and work anniversary (day + month only).
 *   `roster`        next week's roster still unpublished for an operational
 *                   department.
 *
 * OVERLAPPING CLASSES CANNOT DOUBLE-SEND. `?classes=document,fssai` scans the same
 * FSSAI certificate twice, so every `dedupe_key` is derived from the SOURCE ROW and
 * the days-remaining bucket — never from the class that found it. The second scan's
 * `NOT EXISTS` guard suppresses the insert. Same property makes `compoff` here and
 * `cron-compoff-expiry`'s own −14/−7/−1 notices interchangeable: whichever runs
 * first enqueues, the other adds nothing.
 *
 * ENQUEUE ONLY. Every row is `channel = 'in_app'`, `status = 'queued'`;
 * `notification-dispatch` (#14) owns the email fan-out, per-user preferences and
 * quiet hours. Sending from here would mean two emails per event.
 *
 * PRIVACY. The celebration scan reads `date_of_birth_actual` (the real date, kept
 * apart from the public one) but NEVER puts a date of birth in a title, body or
 * payload — a greeting does not need it, and `notifications.payload` is read by the
 * dispatcher and rendered into email.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { methodNotAllowed, ok, toProblem, unprocessable } from "../_shared/errors.ts";
import { common, decodeJson, parse, readRawBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { addDays, financialYear, istInstant, istParts, istToday } from "../_shared/datetime.ts";
import {
  clientIpFrom,
  firstRow,
  type RequestContext,
  requestIdFrom,
  sql,
  userAgentFrom,
  withContext,
} from "../_shared/db.ts";
import type { Sql } from "../_shared/deps.ts";
import { rejectBrowserOrigin, verifyCron } from "../_shared/auth.ts";
import { enforce, limitKey, RATE_LIMITS } from "../_shared/ratelimit.ts";
import { auditJobRun } from "../_shared/audit.ts";
import {
  claim,
  idempotencyKeyFrom,
  release,
  replayResponse,
  requestHash,
  store,
} from "../_shared/idempotency.ts";

const FN_NAME = "cron-expiry-reminders";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

const CLASSES = [
  "probation",
  "contract",
  "document",
  "identity",
  "licence",
  "fssai",
  "fire_safety",
  "insurance",
  "compoff",
  "leave_lapse",
  "celebration",
  "roster",
] as const;
type ReminderClass = typeof CLASSES[number];

/** `cron_jobs.code` for each class (migration 041 §2), used for the `job_runs` row. */
const JOB_CODE_BY_CLASS: Record<ReminderClass, string> = {
  probation: "probation_due",
  contract: "contract_expiry",
  document: "document_expiry",
  identity: "document_expiry",
  licence: "document_expiry",
  fssai: "document_expiry",
  fire_safety: "document_expiry",
  insurance: "document_expiry",
  compoff: "comp_off_expiring",
  leave_lapse: "leave_balance_lapsing",
  celebration: "birthday_anniversary",
  roster: "roster_publish_reminder",
};

// §8.9 windows, in days remaining.
const PROBATION_WINDOWS = [30, 15, 7, 0] as const;
const CONTRACT_WINDOWS = [60, 30, 15, 7] as const;
const COMP_OFF_WINDOWS = [14, 7, 1] as const;
/** `document_types.expiry_reminder_days` default — used for the satellites, which have no type row. */
const DEFAULT_EXPIRY_WINDOWS = [60, 30, 14, 7, 1] as const;
/** Probation overdue by more than this escalates to the department head. */
const PROBATION_ESCALATE_AFTER_DAYS = 15;

/** Employees a reminder can be about. An exited employee's expiries are settlement, not HR nagging. */
const IN_SERVICE_STATUSES = [
  "active",
  "on_probation",
  "confirmed",
  "on_notice",
  "on_long_leave",
  "suspended",
] as const;

/** Document type codes per venue-critical class. */
const FSSAI_DOC_CODES = ["FSSAI_CERT"] as const;
const FIRE_SAFETY_DOC_CODES = ["FIRE_SAFETY_CERT"] as const;
/** `employee_qualifications.licence_kind` per venue-critical class (`ck_eq__licence_kind`). */
const FSSAI_LICENCE_KINDS = ["food_safety", "fssai_supervisor"] as const;
const FIRE_SAFETY_LICENCE_KINDS = ["fire_safety"] as const;

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5_000;
/** Candidate rows one class may pull. Anything larger is a data problem, not a nag list. */
const MAX_CANDIDATES = 5_000;

const RemindersBody = z
  .object({
    /** `cron_jobs.code`; defaults to the code of the first requested class. */
    job_code: z.string().trim().min(2).max(64).optional(),
    /** Absent = every class (a manual catch-all run). */
    classes: z.array(z.enum(CLASSES)).min(1).max(CLASSES.length).optional(),
    /** IST date the windows are measured from. Absent = today IST. */
    as_of: common.isoDate.optional(),
    /** Resolve and report, enqueue nothing. */
    dry_run: z.boolean().default(false),
    /** Notification ceiling for the whole run. */
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict();

/** `?classes=probation,contract` → the validated list. Unknown names are a 422. */
function classesFromQuery(raw: string | null): ReminderClass[] | null {
  if (raw === null || raw.trim() === "") return null;
  const parts = raw.split(",").map((p) => p.trim()).filter((p) => p !== "");
  const unknown = parts.filter((p) => !(CLASSES as readonly string[]).includes(p));
  if (unknown.length > 0) {
    throw unprocessable(
      unknown.map((name) => ({
        pointer: "/classes",
        code: "invalid_enum_value",
        detail: `Unknown reminder class \`${name}\`.`,
      })),
      "The `classes` query parameter names a class this job does not run.",
      "UNKNOWN_REMINDER_CLASS",
    );
  }
  return [...new Set(parts)] as ReminderClass[];
}

// ── Notification model ──────────────────────────────────────────────────────

type Priority = "low" | "normal" | "high" | "critical";

interface Recipient {
  /** `notifications.employee_id`. NULL for an admin with no employee record. */
  employeeId: string | null;
  /** `notifications.profile_id`. At least one of the two must be non-null (`ck_notifications__recipient`). */
  profileId: string | null;
  /** Suffix that makes the dedupe key unique per recipient. */
  key: string;
}

interface Reminder {
  eventCode: string;
  companyId: string;
  title: string;
  body: string;
  deepLink: string | null;
  payload: Record<string, unknown>;
  priority: Priority;
  /** Derived from the SOURCE ROW + window, never from the class (see the header). */
  dedupeBase: string;
  recipients: Recipient[];
}

/**
 * One row per (reminder × recipient), guarded by `dedupe_key`.
 *
 * The unique index on `dedupe_key` lives on each PARTITION, not on the partitioned
 * parent (migration 027 table comment), so `ON CONFLICT` has no index to infer and
 * the guard has to be an explicit `NOT EXISTS`. Under the `app.job_begin` lock this
 * is safe; a losing race would raise 23505 and abort the batch rather than
 * double-notify, which is the correct failure direction.
 *
 * `template_id` is resolved per company + event code + `in_app`. A NULL is fine:
 * `notification-dispatch` falls back to the pre-rendered `title`/`body`, which is
 * why they are stored rendered rather than as `{{tokens}}`.
 */
async function enqueue(tx: Sql, reminders: readonly Reminder[], cap: number): Promise<number> {
  let queued = 0;
  for (const reminder of reminders) {
    for (const recipient of reminder.recipients) {
      if (queued >= cap) return queued;
      if (recipient.profileId === null && recipient.employeeId === null) continue;
      const dedupe = `${reminder.dedupeBase}:${recipient.key}`;
      const rows = await tx`
        INSERT INTO public.notifications
          (employee_id, profile_id, template_id, event_code, channel, title, body,
           deep_link, payload, priority, status, dedupe_key)
        SELECT ${recipient.employeeId}::uuid,
               ${recipient.profileId}::uuid,
               (SELECT t.id FROM public.notification_templates t
                 WHERE t.company_id = ${reminder.companyId}::uuid
                   AND t.code = ${reminder.eventCode}
                   AND t.channel = 'in_app'
                   AND t.is_active AND t.deleted_at IS NULL
                 LIMIT 1),
               ${reminder.eventCode}::text,
               'in_app'::public.notification_channel,
               ${reminder.title}::text,
               ${reminder.body}::text,
               ${reminder.deepLink}::text,
               ${JSON.stringify(reminder.payload)}::jsonb,
               ${reminder.priority}::text,
               'queued'::public.notification_status,
               ${dedupe}::text
         WHERE NOT EXISTS (
           SELECT 1 FROM public.notifications n WHERE n.dedupe_key = ${dedupe}::text)
        RETURNING 1
      `;
      queued += (rows as unknown as unknown[]).length;
    }
  }
  return queued;
}

/** Live admin/HR profiles — the standing recipient list for every HR-facing reminder. */
async function hrRecipients(client: Sql): Promise<Recipient[]> {
  const rows = await client<{ profile_id: string; employee_id: string | null }[]>`
    SELECT DISTINCT p.id AS profile_id, he.id AS employee_id
      FROM public.user_roles ur
      JOIN public.profiles p ON p.id = ur.user_id AND p.is_active
      LEFT JOIN public.employees he ON he.profile_id = p.id AND he.deleted_at IS NULL
     WHERE ur.revoked_at IS NULL
       AND ur.role IN ('admin', 'super_admin')
  `;
  return (rows as unknown as { profile_id: string; employee_id: string | null }[]).map((r) => ({
    employeeId: r.employee_id,
    profileId: r.profile_id,
    key: `hr:${r.profile_id}`,
  }));
}

/** Columns every scan needs about the subject and who is accountable for them. */
const SUBJECT_COLUMNS = `
           e.id                       AS employee_id,
           e.company_id               AS company_id,
           e.employee_code            AS employee_code,
           e.display_name             AS display_name,
           e.first_name               AS first_name,
           ep.id                      AS employee_profile_id,
           m.id                       AS manager_employee_id,
           mp.id                      AS manager_profile_id,
           dh.id                      AS dept_head_employee_id,
           dhp.id                     AS dept_head_profile_id`;

const SUBJECT_JOINS = `
      LEFT JOIN public.profiles    ep  ON ep.id = e.profile_id AND ep.is_active
      LEFT JOIN public.employees   m   ON m.id = e.reporting_manager_id AND m.deleted_at IS NULL
      LEFT JOIN public.profiles    mp  ON mp.id = m.profile_id AND mp.is_active
      LEFT JOIN public.departments d   ON d.id = e.department_id AND d.deleted_at IS NULL
      LEFT JOIN public.employees   dh  ON dh.id = d.head_employee_id AND dh.deleted_at IS NULL
      LEFT JOIN public.profiles    dhp ON dhp.id = dh.profile_id AND dhp.is_active`;

interface SubjectRow {
  employee_id: string;
  company_id: string;
  employee_code: string;
  display_name: string;
  first_name: string;
  employee_profile_id: string | null;
  manager_employee_id: string | null;
  manager_profile_id: string | null;
  dept_head_employee_id: string | null;
  dept_head_profile_id: string | null;
}

function selfRecipient(row: SubjectRow): Recipient[] {
  return row.employee_profile_id === null
    ? []
    : [{ employeeId: row.employee_id, profileId: row.employee_profile_id, key: "self" }];
}

function managerRecipient(row: SubjectRow): Recipient[] {
  return row.manager_profile_id === null
    ? []
    : [{
      employeeId: row.manager_employee_id,
      profileId: row.manager_profile_id,
      key: `mgr:${row.manager_profile_id}`,
    }];
}

function deptHeadRecipient(row: SubjectRow): Recipient[] {
  // A department head who is also the manager would get two copies of the same
  // event; the manager copy is the one that means "act on this".
  if (row.dept_head_profile_id === null) return [];
  if (row.dept_head_profile_id === row.manager_profile_id) return [];
  return [{
    employeeId: row.dept_head_employee_id,
    profileId: row.dept_head_profile_id,
    key: `head:${row.dept_head_profile_id}`,
  }];
}

function asInt(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function asNum(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** `12` → "in 12 days", `0` → "today", `-3` → "3 days ago". Reused in every body. */
function whenPhrase(daysUntil: number): string {
  if (daysUntil === 0) return "today";
  if (daysUntil === 1) return "tomorrow";
  if (daysUntil > 1) return `in ${daysUntil} days`;
  if (daysUntil === -1) return "yesterday";
  return `${Math.abs(daysUntil)} days ago`;
}

function ddMon(isoDate: string): string {
  const MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ] as const;
  const month = MONTHS[Number(isoDate.slice(5, 7)) - 1] ?? isoDate.slice(5, 7);
  return `${isoDate.slice(8, 10)}-${month}-${isoDate.slice(0, 4)}`;
}

// ── Class scanners ──────────────────────────────────────────────────────────

async function scanProbation(client: Sql, asOf: string, limit: number): Promise<Reminder[]> {
  const rows = await client.unsafe(
    `SELECT ${SUBJECT_COLUMNS},
            e.confirmation_due_date::text                AS due_date,
            (e.confirmation_due_date - $1::date)         AS days_until
       FROM public.employees e${SUBJECT_JOINS}
      WHERE e.deleted_at IS NULL
        AND e.employment_status = 'on_probation'
        AND e.confirmation_due_date IS NOT NULL
        AND ((e.confirmation_due_date - $1::date) = ANY ($2::integer[])
             OR ($1::date - e.confirmation_due_date) > $3::integer)
      ORDER BY e.confirmation_due_date
      LIMIT $4`,
    [asOf, [...PROBATION_WINDOWS], PROBATION_ESCALATE_AFTER_DAYS, limit],
  );

  const out: Reminder[] = [];
  for (const raw of rows as unknown as (SubjectRow & { due_date: string; days_until: unknown })[]) {
    const daysUntil = asInt(raw.days_until);
    const dueDate = raw.due_date;
    const overdue = -daysUntil;

    if ((PROBATION_WINDOWS as readonly number[]).includes(daysUntil)) {
      out.push({
        eventCode: "PROBATION_DUE",
        companyId: raw.company_id,
        title: `Probation confirmation due ${whenPhrase(daysUntil)}: ${raw.display_name}`,
        body: `${raw.display_name} (${raw.employee_code}) completes probation on ` +
          `${ddMon(dueDate)}. Record the confirmation decision before that date.`,
        deepLink: `/admin/employees/${raw.employee_id}/lifecycle`,
        payload: {
          employee_id: raw.employee_id,
          employee_code: raw.employee_code,
          employee_name: raw.display_name,
          confirmation_due_date: dueDate,
          days_until: daysUntil,
        },
        priority: daysUntil <= 7 ? "high" : "normal",
        dedupeBase: `PROBATION_DUE:${raw.employee_id}:${dueDate}:d${daysUntil}`,
        recipients: [...managerRecipient(raw)],
      });
    }

    if (overdue > PROBATION_ESCALATE_AFTER_DAYS) {
      // Weekly bucket: an overdue confirmation must keep surfacing, but a daily
      // job must not send a daily nag for a month.
      const week = Math.floor(overdue / 7);
      out.push({
        eventCode: "PROBATION_DUE",
        companyId: raw.company_id,
        title: `Probation OVERDUE ${overdue} days: ${raw.display_name}`,
        body: `${raw.display_name} (${raw.employee_code}) was due for confirmation on ` +
          `${ddMon(dueDate)} — ${overdue} days ago — and is still on probation. ` +
          `Escalated to the department head.`,
        deepLink: `/admin/employees/${raw.employee_id}/lifecycle`,
        payload: {
          employee_id: raw.employee_id,
          employee_code: raw.employee_code,
          employee_name: raw.display_name,
          confirmation_due_date: dueDate,
          days_overdue: overdue,
          escalated: true,
        },
        priority: "high",
        dedupeBase: `PROBATION_DUE:${raw.employee_id}:${dueDate}:esc:w${week}`,
        recipients: [...deptHeadRecipient(raw), ...managerRecipient(raw)],
      });
    }
  }
  return out;
}

async function scanContract(client: Sql, asOf: string, limit: number): Promise<Reminder[]> {
  const rows = await client.unsafe(
    `SELECT ${SUBJECT_COLUMNS},
            e.contract_end_date::text            AS end_date,
            (e.contract_end_date - $1::date)     AS days_until
       FROM public.employees e${SUBJECT_JOINS}
      WHERE e.deleted_at IS NULL
        AND e.contract_end_date IS NOT NULL
        AND e.employment_status = ANY ($2::public.employment_status[])
        AND (e.contract_end_date - $1::date) = ANY ($3::integer[])
      ORDER BY e.contract_end_date
      LIMIT $4`,
    [asOf, [...IN_SERVICE_STATUSES], [...CONTRACT_WINDOWS], limit],
  );

  return (rows as unknown as (SubjectRow & { end_date: string; days_until: unknown })[]).map(
    (raw) => {
      const daysUntil = asInt(raw.days_until);
      return {
        eventCode: "CONTRACT_EXPIRING",
        companyId: raw.company_id,
        title: `Contract ends ${whenPhrase(daysUntil)}: ${raw.display_name}`,
        body: `${raw.display_name}'s (${raw.employee_code}) contract ends on ` +
          `${ddMon(raw.end_date)}. Renew, convert or start the exit process.`,
        deepLink: `/admin/employees/${raw.employee_id}/employment`,
        payload: {
          employee_id: raw.employee_id,
          employee_code: raw.employee_code,
          employee_name: raw.display_name,
          contract_end_date: raw.end_date,
          days_until: daysUntil,
        },
        priority: daysUntil <= 15 ? "high" : "normal",
        dedupeBase: `CONTRACT_EXPIRING:${raw.employee_id}:${raw.end_date}:d${daysUntil}`,
        recipients: [...managerRecipient(raw)],
      };
    },
  );
}

/**
 * `documents` against each type's own `expiry_reminder_days`.
 *
 * `codes`/`likePattern` narrow the scan for the venue-critical classes;
 * `null`/`null` is the whole catalogue. Because `dedupe_key` is
 * `DOCUMENT_EXPIRING:doc:<id>:d<days>`, a narrow class and the broad one can both
 * run in the same invocation without double-sending.
 */
async function scanDocuments(
  client: Sql,
  asOf: string,
  codes: readonly string[] | null,
  likePattern: string | null,
  limit: number,
): Promise<Reminder[]> {
  const rows = await client.unsafe(
    `SELECT ${SUBJECT_COLUMNS},
            doc.id                            AS document_id,
            doc.title                         AS doc_title,
            doc.expiry_date::text             AS expiry_date,
            (doc.expiry_date - $1::date)      AS days_until,
            dt.code                           AS type_code,
            dt.name                           AS type_name,
            dt.visible_to_employee            AS visible_to_employee
       FROM public.documents doc
       JOIN public.document_types dt ON dt.id = doc.document_type_id AND dt.deleted_at IS NULL
       JOIN public.employees e ON e.id = doc.employee_id AND e.deleted_at IS NULL${SUBJECT_JOINS}
      WHERE doc.deleted_at IS NULL
        AND doc.archived_at IS NULL
        AND doc.expiry_date IS NOT NULL
        AND doc.status IN ('approved', 'pending_review')
        AND e.employment_status = ANY ($2::public.employment_status[])
        AND (doc.expiry_date - $1::date) = ANY (dt.expiry_reminder_days)
        AND ($3::text[] IS NULL OR dt.code = ANY ($3::text[]))
        AND ($4::text IS NULL OR dt.code ILIKE $4::text OR dt.category ILIKE $4::text)
      ORDER BY doc.expiry_date
      LIMIT $5`,
    [asOf, [...IN_SERVICE_STATUSES], codes === null ? null : [...codes], likePattern, limit],
  );

  return (rows as unknown as (SubjectRow & Record<string, unknown>)[]).map((raw) => {
    const daysUntil = asInt(raw.days_until);
    const expiry = String(raw.expiry_date);
    const label = String(raw.type_name ?? raw.doc_title ?? "Document");
    return {
      eventCode: "DOCUMENT_EXPIRING",
      companyId: raw.company_id,
      title: `${label} expires ${whenPhrase(daysUntil)}: ${raw.display_name}`,
      body: `${label} for ${raw.display_name} (${raw.employee_code}) expires on ` +
        `${ddMon(expiry)}. Upload the renewed copy before it lapses.`,
      deepLink: `/admin/employees/${raw.employee_id}/documents`,
      payload: {
        document_id: String(raw.document_id),
        document_type: String(raw.type_code),
        document_title: String(raw.doc_title ?? label),
        employee_id: raw.employee_id,
        employee_code: raw.employee_code,
        employee_name: raw.display_name,
        expiry_date: expiry,
        days_until: daysUntil,
      },
      priority: daysUntil <= 7 ? "high" : "normal",
      dedupeBase: `DOCUMENT_EXPIRING:doc:${String(raw.document_id)}:d${daysUntil}`,
      recipients: raw.visible_to_employee === true ? [...selfRecipient(raw)] : [],
    };
  });
}

/** `employee_identity_documents` — passports and visas, current rows only. */
async function scanIdentityDocuments(
  client: Sql,
  asOf: string,
  limit: number,
): Promise<Reminder[]> {
  const rows = await client.unsafe(
    `SELECT ${SUBJECT_COLUMNS},
            eid.id                        AS eid_id,
            eid.document_kind::text       AS document_kind,
            eid.expiry_date::text         AS expiry_date,
            (eid.expiry_date - $1::date)  AS days_until
       FROM public.employee_identity_documents eid
       JOIN public.employees e ON e.id = eid.employee_id AND e.deleted_at IS NULL${SUBJECT_JOINS}
      WHERE eid.is_current
        AND eid.expiry_date IS NOT NULL
        AND e.employment_status = ANY ($2::public.employment_status[])
        AND (eid.expiry_date - $1::date) = ANY ($3::integer[])
      ORDER BY eid.expiry_date
      LIMIT $4`,
    [asOf, [...IN_SERVICE_STATUSES], [...DEFAULT_EXPIRY_WINDOWS], limit],
  );

  return (rows as unknown as (SubjectRow & Record<string, unknown>)[]).map((raw) => {
    const daysUntil = asInt(raw.days_until);
    const expiry = String(raw.expiry_date);
    const kind = String(raw.document_kind).replace(/_/g, " ");
    return {
      eventCode: "DOCUMENT_EXPIRING",
      companyId: raw.company_id,
      title: `Your ${kind} expires ${whenPhrase(daysUntil)}`,
      body: `Your ${kind} on file expires on ${ddMon(expiry)}. ` +
        `Give HR the renewed document so your records stay valid.`,
      deepLink: "/me/profile/documents",
      payload: {
        identity_document_id: String(raw.eid_id),
        // Deliberately no document number: `notifications.payload` is rendered
        // into email, and an ID number is masked-by-default everywhere else.
        document_kind: String(raw.document_kind),
        employee_id: raw.employee_id,
        employee_code: raw.employee_code,
        employee_name: raw.display_name,
        expiry_date: expiry,
        days_until: daysUntil,
      },
      priority: daysUntil <= 7 ? "high" : "normal",
      dedupeBase: `DOCUMENT_EXPIRING:eid:${String(raw.eid_id)}:d${daysUntil}`,
      recipients: [...selfRecipient(raw)],
    };
  });
}

/**
 * `employee_qualifications.licence_expiry`. Food-safety, FSSAI-supervisor,
 * first-aid, fire-safety, bartending and driving licences all live here
 * (`ck_eq__licence_kind`), and a lapsed one is a venue compliance breach — hence
 * employee AND manager AND (via the caller) HR.
 */
async function scanLicences(
  client: Sql,
  asOf: string,
  kinds: readonly string[] | null,
  limit: number,
): Promise<Reminder[]> {
  const rows = await client.unsafe(
    `SELECT ${SUBJECT_COLUMNS},
            eq.id                          AS eq_id,
            eq.licence_kind                AS licence_kind,
            eq.licence_expiry::text        AS expiry_date,
            (eq.licence_expiry - $1::date) AS days_until
       FROM public.employee_qualifications eq
       JOIN public.employees e ON e.id = eq.employee_id AND e.deleted_at IS NULL${SUBJECT_JOINS}
      WHERE eq.licence_expiry IS NOT NULL
        AND e.employment_status = ANY ($2::public.employment_status[])
        AND (eq.licence_expiry - $1::date) = ANY ($3::integer[])
        AND ($4::text[] IS NULL OR eq.licence_kind = ANY ($4::text[]))
      ORDER BY eq.licence_expiry
      LIMIT $5`,
    [asOf, [...IN_SERVICE_STATUSES], [...DEFAULT_EXPIRY_WINDOWS], kinds === null ? null : [...kinds], limit],
  );

  return (rows as unknown as (SubjectRow & Record<string, unknown>)[]).map((raw) => {
    const daysUntil = asInt(raw.days_until);
    const expiry = String(raw.expiry_date);
    const kind = String(raw.licence_kind ?? "licence").replace(/_/g, " ");
    return {
      eventCode: "LICENCE_EXPIRING",
      companyId: raw.company_id,
      title: `${kind} licence expires ${whenPhrase(daysUntil)}: ${raw.display_name}`,
      body: `${raw.display_name}'s (${raw.employee_code}) ${kind} licence expires on ` +
        `${ddMon(expiry)}. Renewal is a compliance requirement for this venue.`,
      deepLink: `/admin/employees/${raw.employee_id}/qualifications`,
      payload: {
        qualification_id: String(raw.eq_id),
        licence_kind: raw.licence_kind === null ? null : String(raw.licence_kind),
        employee_id: raw.employee_id,
        employee_code: raw.employee_code,
        employee_name: raw.display_name,
        expiry_date: expiry,
        days_until: daysUntil,
      },
      priority: "high",
      dedupeBase: `LICENCE_EXPIRING:eq:${String(raw.eq_id)}:d${daysUntil}`,
      recipients: [...selfRecipient(raw), ...managerRecipient(raw)],
    };
  });
}

/** Comp-off credits about to expire, −14 / −7 / −1 days (§8.3). */
async function scanCompOff(client: Sql, asOf: string, limit: number): Promise<Reminder[]> {
  const rows = await client.unsafe(
    `SELECT ${SUBJECT_COLUMNS},
            col.id                                            AS ledger_id,
            col.expires_on::text                              AS expires_on,
            (col.expires_on - $1::date)                       AS days_until,
            COALESCE(col.days_remaining, col.days)::text      AS days_left,
            col.earned_on_date::text                          AS earned_on
       FROM public.comp_off_ledger col
       JOIN public.employees e ON e.id = col.employee_id AND e.deleted_at IS NULL${SUBJECT_JOINS}
      WHERE col.entry_type = 'earned'
        AND col.status IN ('available', 'partially_used')
        AND col.expires_on IS NOT NULL
        AND COALESCE(col.days_remaining, col.days) > 0
        AND e.employment_status = ANY ($2::public.employment_status[])
        AND (col.expires_on - $1::date) = ANY ($3::integer[])
      ORDER BY col.expires_on
      LIMIT $4`,
    [asOf, [...IN_SERVICE_STATUSES], [...COMP_OFF_WINDOWS], limit],
  );

  return (rows as unknown as (SubjectRow & Record<string, unknown>)[]).map((raw) => {
    const daysUntil = asInt(raw.days_until);
    const daysLeft = asNum(raw.days_left);
    const expires = String(raw.expires_on);
    return {
      eventCode: "COMP_OFF_EXPIRING",
      companyId: raw.company_id,
      title: `${daysLeft} comp-off day(s) expire ${whenPhrase(daysUntil)}`,
      body: `${daysLeft} comp-off day(s)${
        raw.earned_on === null ? "" : ` earned on ${ddMon(String(raw.earned_on))}`
      } expire on ${ddMon(expires)}. Apply for them before then or they lapse.`,
      deepLink: "/me/leave/new?type=comp_off",
      payload: {
        comp_off_ledger_id: String(raw.ledger_id),
        employee_id: raw.employee_id,
        employee_code: raw.employee_code,
        days_remaining: daysLeft,
        expires_on: expires,
        days_until: daysUntil,
      },
      priority: daysUntil <= 1 ? "high" : "normal",
      dedupeBase: `COMP_OFF_EXPIRING:${String(raw.ledger_id)}:d${daysUntil}`,
      recipients: [...selfRecipient(raw)],
    };
  });
}

/**
 * Leave that will LAPSE at financial-year end: the balance above
 * `max_carry_forward_days`, or the whole balance for a type that does not carry
 * forward at all. Deduped per calendar MONTH, because the job is scheduled on the
 * 1st of January, February and March and each of those should nag once.
 */
async function scanLeaveLapse(
  client: Sql,
  asOf: string,
  leaveYear: number,
  limit: number,
): Promise<Reminder[]> {
  const rows = await client.unsafe(
    `SELECT ${SUBJECT_COLUMNS},
            lb.leave_type_id                     AS leave_type_id,
            lt.code                              AS leave_type_code,
            lt.name                              AS leave_type_name,
            lb.available_days::text              AS available_days,
            lt.carry_forward_allowed             AS carry_forward_allowed,
            lt.max_carry_forward_days::text      AS max_carry_forward_days
       FROM public.leave_balances lb
       JOIN public.leave_types lt ON lt.id = lb.leave_type_id
                                 AND lt.deleted_at IS NULL AND lt.is_active
                                 AND NOT lt.is_comp_off
       JOIN public.employees e ON e.id = lb.employee_id AND e.deleted_at IS NULL${SUBJECT_JOINS}
      WHERE lb.leave_year = $1::integer
        AND lb.available_days > 0
        AND e.employment_status = ANY ($2::public.employment_status[])
        AND (NOT lt.carry_forward_allowed
             OR (lt.max_carry_forward_days IS NOT NULL
                 AND lb.available_days > lt.max_carry_forward_days))
      ORDER BY lb.available_days DESC
      LIMIT $3`,
    [leaveYear, [...IN_SERVICE_STATUSES], limit],
  );

  const fyEnd = `${leaveYear + 1}-03-31`;
  const monthBucket = asOf.slice(0, 7);
  return (rows as unknown as (SubjectRow & Record<string, unknown>)[]).map((raw) => {
    const available = asNum(raw.available_days);
    const cap = raw.max_carry_forward_days === null ? null : asNum(raw.max_carry_forward_days);
    const carried = raw.carry_forward_allowed === true
      ? Math.min(available, cap ?? available)
      : 0;
    const lapsing = Math.round((available - carried) * 1000) / 1000;
    const typeName = String(raw.leave_type_name);
    return {
      eventCode: "LEAVE_BALANCE_LAPSING",
      companyId: raw.company_id,
      title: `${lapsing} ${typeName} day(s) will lapse on ${ddMon(fyEnd)}`,
      body: `You have ${available} ${typeName} day(s). ${
        carried > 0
          ? `Only ${carried} can be carried into the next financial year, so ${lapsing} will lapse`
          : `${typeName} does not carry forward, so all ${lapsing} will lapse`
      } on ${ddMon(fyEnd)}. Plan your leave.`,
      deepLink: "/me/leave",
      payload: {
        employee_id: raw.employee_id,
        employee_code: raw.employee_code,
        leave_type_id: String(raw.leave_type_id),
        leave_type_code: String(raw.leave_type_code),
        leave_type_name: typeName,
        available_days: available,
        carry_forward_days: carried,
        lapsing_days: lapsing,
        financial_year_end: fyEnd,
      },
      priority: "normal",
      dedupeBase:
        `LEAVE_BALANCE_LAPSING:${raw.employee_id}:${String(raw.leave_type_id)}:${leaveYear}:${monthBucket}`,
      recipients: [...selfRecipient(raw)],
    };
  });
}

/**
 * Birthdays and work anniversaries — day and month only, never the year.
 *
 * `date_of_birth_actual` wins over `date_of_birth` when present (§8.9); the actual
 * date is the private one, so it is used to CHOOSE the day and then discarded.
 * 29-Feb birthdays are greeted on 28-Feb in a non-leap year, which the caller
 * decides because leapness is a property of the run date.
 */
async function scanCelebrations(
  client: Sql,
  asOf: string,
  isLeapYear: boolean,
  limit: number,
): Promise<Reminder[]> {
  const rows = await client.unsafe(
    `SELECT ${SUBJECT_COLUMNS},
            (to_char(COALESCE(e.date_of_birth_actual, e.date_of_birth), 'MM-DD')
               = to_char($1::date, 'MM-DD')
             OR (NOT $2::boolean
                 AND to_char(COALESCE(e.date_of_birth_actual, e.date_of_birth), 'MM-DD') = '02-29'
                 AND to_char($1::date, 'MM-DD') = '02-28'))          AS is_birthday,
            (to_char(e.date_of_join, 'MM-DD') = to_char($1::date, 'MM-DD')
             AND e.date_of_join < $1::date)                          AS is_anniversary,
            (EXTRACT(YEAR FROM $1::date) - EXTRACT(YEAR FROM e.date_of_join))::integer AS years_of_service
       FROM public.employees e${SUBJECT_JOINS}
      WHERE e.deleted_at IS NULL
        AND e.employment_status = ANY ($3::public.employment_status[])
        AND (
          to_char(COALESCE(e.date_of_birth_actual, e.date_of_birth), 'MM-DD') = to_char($1::date, 'MM-DD')
          OR (NOT $2::boolean
              AND to_char(COALESCE(e.date_of_birth_actual, e.date_of_birth), 'MM-DD') = '02-29'
              AND to_char($1::date, 'MM-DD') = '02-28')
          OR (to_char(e.date_of_join, 'MM-DD') = to_char($1::date, 'MM-DD') AND e.date_of_join < $1::date)
        )
      ORDER BY e.employee_code
      LIMIT $4`,
    [asOf, isLeapYear, [...IN_SERVICE_STATUSES], limit],
  );

  const year = asOf.slice(0, 4);
  const out: Reminder[] = [];
  for (const raw of rows as unknown as (SubjectRow & Record<string, unknown>)[]) {
    if (raw.is_birthday === true) {
      out.push({
        eventCode: "BIRTHDAY",
        companyId: raw.company_id,
        title: `Happy birthday, ${raw.first_name}!`,
        body: `Wishing you a wonderful year ahead from everyone at Tamarind Tree.`,
        deepLink: "/me",
        // No date of birth in the payload: the dispatcher renders payload into email.
        payload: {
          employee_id: raw.employee_id,
          employee_code: raw.employee_code,
          employee_name: raw.display_name,
          first_name: raw.first_name,
        },
        priority: "low",
        dedupeBase: `BIRTHDAY:${raw.employee_id}:${year}`,
        recipients: [...selfRecipient(raw)],
      });
      out.push({
        eventCode: "BIRTHDAY",
        companyId: raw.company_id,
        title: `${raw.display_name} has a birthday today`,
        body: `Today is ${raw.display_name}'s (${raw.employee_code}) birthday.`,
        deepLink: "/team/people",
        payload: {
          employee_id: raw.employee_id,
          employee_code: raw.employee_code,
          employee_name: raw.display_name,
        },
        priority: "low",
        dedupeBase: `BIRTHDAY:${raw.employee_id}:${year}:team`,
        recipients: [...managerRecipient(raw)],
      });
    }
    const years = asInt(raw.years_of_service);
    if (raw.is_anniversary === true && years >= 1) {
      out.push({
        eventCode: "WORK_ANNIVERSARY",
        companyId: raw.company_id,
        title: `${years} year${years === 1 ? "" : "s"} at Tamarind Tree — congratulations!`,
        body: `Today marks ${years} year${years === 1 ? "" : "s"} since you joined us, ` +
          `${raw.first_name}. Thank you for everything.`,
        deepLink: "/me",
        payload: {
          employee_id: raw.employee_id,
          employee_code: raw.employee_code,
          employee_name: raw.display_name,
          first_name: raw.first_name,
          years_of_service: years,
        },
        priority: "low",
        dedupeBase: `WORK_ANNIVERSARY:${raw.employee_id}:${year}`,
        recipients: [...selfRecipient(raw), ...managerRecipient(raw)],
      });
    }
  }
  return out;
}

/**
 * Next week's roster still unpublished, per operational department (§8.9,
 * Wednesdays 11:00 IST). `locked` counts as published — it is past publication.
 *
 * `ROSTER_PUBLISH_REMINDER` is not one of the 26 seeded template codes, so
 * `template_id` resolves to NULL and `notification-dispatch` renders from the
 * pre-rendered `title`/`body`. Adding the template row later changes nothing here.
 */
async function scanRoster(
  client: Sql,
  nextMonday: string,
  companyId: string | null,
  limit: number,
): Promise<Reminder[]> {
  const rows = await client<Record<string, unknown>[]>`
    SELECT d.id                AS department_id,
           d.name              AS department_name,
           d.company_id        AS company_id,
           dh.id               AS dept_head_employee_id,
           dhp.id              AS dept_head_profile_id
      FROM public.departments d
      LEFT JOIN public.employees dh  ON dh.id = d.head_employee_id AND dh.deleted_at IS NULL
      LEFT JOIN public.profiles  dhp ON dhp.id = dh.profile_id AND dhp.is_active
     WHERE d.deleted_at IS NULL
       AND d.is_active
       AND d.is_operational
       AND (${companyId}::uuid IS NULL OR d.company_id = ${companyId}::uuid)
       AND NOT EXISTS (
         SELECT 1 FROM public.rosters r
          WHERE r.department_id = d.id
            AND r.week_start_date = ${nextMonday}::date
            AND r.deleted_at IS NULL
            AND r.status IN ('published', 'locked'))
     ORDER BY d.sort_order, d.name
     LIMIT ${limit}
  `;

  return (rows as unknown as Record<string, unknown>[]).map((raw) => ({
    eventCode: "ROSTER_PUBLISH_REMINDER",
    companyId: String(raw.company_id),
    title: `${String(raw.department_name)} roster for ${ddMon(nextMonday)} is not published`,
    body: `The week starting ${ddMon(nextMonday)} has no published roster for ` +
      `${String(raw.department_name)}. Staff cannot see their shifts until it is published.`,
    deepLink: `/admin/rosters?week=${nextMonday}&department=${String(raw.department_id)}`,
    payload: {
      department_id: String(raw.department_id),
      department_name: String(raw.department_name),
      week_start_date: nextMonday,
    },
    priority: "high" as Priority,
    dedupeBase: `ROSTER_PUBLISH_REMINDER:${String(raw.department_id)}:${nextMonday}`,
    recipients: raw.dept_head_profile_id === null ? [] : [{
      employeeId: raw.dept_head_employee_id === null ? null : String(raw.dept_head_employee_id),
      profileId: String(raw.dept_head_profile_id),
      key: `head:${String(raw.dept_head_profile_id)}`,
    }],
  }));
}

/** Every reminder an HR/admin desk should see as well as the line manager. */
function withHr(reminders: Reminder[], hr: readonly Recipient[]): Reminder[] {
  return reminders.map((r) => ({ ...r, recipients: [...r.recipients, ...hr] }));
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
  const url = new URL(req.url);
  const instance = url.pathname;

  let status = 500;
  let idempotencyKey: string | null = null;
  let jobRunId: string | null = null;
  let jobCode = "expiry_reminders";
  let responseBody: unknown = null;

  try {
    assertOriginAllowed(req);

    // ── STEP 4 · Auth (model C) ─────────────────────────────────────────────
    rejectBrowserOrigin(req);
    const cronAuth = verifyCron(req);
    log.info("cron authenticated", { via: cronAuth.via });

    // ── STEP 5 · Authority ──────────────────────────────────────────────────
    // A scheduled job holds no capability row: the constant-time secret IS the
    // authority.

    const rawBody = await readRawBody(req, { maxBytes: 8 * 1024, requireJsonContentType: false });
    const decoded = rawBody === "" ? {} : decodeJson(rawBody);

    // ── STEP 6 · Rate limit ─────────────────────────────────────────────────
    await enforce(RATE_LIMITS.heavyJob, limitKey(FN_NAME, "cron"), "REMINDERS_RATE_LIMITED");

    // ── STEP 7 · Validate ───────────────────────────────────────────────────
    const body = parse(RemindersBody, decoded, "reminders request");
    const requested = body.classes ?? classesFromQuery(url.searchParams.get("classes")) ?? [...CLASSES];
    const classes = [...new Set(requested)] as ReminderClass[];
    jobCode = body.job_code ?? JOB_CODE_BY_CLASS[classes[0] as ReminderClass] ?? "expiry_reminders";

    const today = istToday();
    const asOf = body.as_of ?? today;
    if (asOf > today) {
      throw unprocessable(
        [{ pointer: "/as_of", code: "too_big", detail: "Reminder windows are measured from today or earlier." }],
        "`as_of` must be today IST or earlier.",
        "AS_OF_IN_FUTURE",
      );
    }

    // ── STEP 8 · Idempotency claim ──────────────────────────────────────────
    // Keyed to the class set + date: a `pg_net` retry replays the stored answer.
    // The per-notification `dedupe_key` is the real anti-duplicate guarantee.
    if (!body.dry_run) {
      idempotencyKey = idempotencyKeyFrom(req) ??
        `${FN_NAME}:${asOf}:${[...classes].sort().join(",")}`;
      const hash = await requestHash(FN_NAME, rawBody, `${asOf}:${classes.join(",")}`);
      const claimed = await claim({ key: idempotencyKey, fnName: FN_NAME, requestHash: hash });
      if (claimed.state === "replay") {
        status = claimed.status;
        log.info("idempotent replay", { key: idempotencyKey });
        return replayResponse(claimed, { ...cors, "x-request-id": requestId });
      }
    }

    const pool = sql();

    // Double-run guard (§9): the lock key includes the class set, so the 09:00,
    // 09:05, 09:10 and 09:15 jobs do not lock each other out.
    if (!body.dry_run) {
      const begun = await pool<{ id: string | null }[]>`
        SELECT app.job_begin(${jobCode}, ${`${FN_NAME}:${jobCode}`}) AS id
      `;
      jobRunId = firstRow(begun)?.id ?? null;
      if (jobRunId === null) {
        status = 200;
        responseBody = { skipped: "already_running", job_code: jobCode, classes, requestId };
        if (idempotencyKey !== null) await store(idempotencyKey, status, responseBody);
        return ok(responseBody, { status, headers: cors, requestId });
      }
    }

    const ctx: RequestContext = {
      actorId: null, // a scheduled job is not a person
      actorRole: null,
      source: "cron",
      sourceRoute: FN_NAME,
      requestId,
      ip: clientIpFrom(req),
      ua: userAgentFrom(req),
      deviceId: null,
      reason: `${FN_NAME}: ${classes.join(",")} windows as of ${asOf}`,
    };

    const hr = await hrRecipients(pool);

    // Financial-year context for the lapse scan (April basis, mirrors
    // `public.leave_year_of`): the FY that is currently open.
    const leaveYear = Number(financialYear(asOf).slice(0, 4));

    // Next week's Monday, in IST. `istParts` on a midday instant avoids any
    // timezone edge at the date boundary.
    const weekday = istParts(istInstant(asOf, "12:00:00")).weekday; // 0 = Sunday
    const untilMonday = ((1 - weekday + 7) % 7) || 7;
    const nextMonday = addDays(asOf, untilMonday);

    const asOfYear = Number(asOf.slice(0, 4));
    const isLeapYear = asOfYear % 4 === 0 && (asOfYear % 100 !== 0 || asOfYear % 400 === 0);

    const companyRows = await pool<{ id: string }[]>`
      SELECT c.id FROM public.companies c WHERE c.deleted_at IS NULL ORDER BY c.code LIMIT 1
    `;
    const companyId = firstRow(companyRows)?.id ?? null;

    // ── Candidate resolution (reads only; nothing is written yet) ────────────
    const perClass: Record<string, { candidates: number; queued: number }> = {};
    const batches: { name: ReminderClass; reminders: Reminder[] }[] = [];

    for (const name of classes) {
      let reminders: Reminder[] = [];
      switch (name) {
        case "probation":
          reminders = withHr(await scanProbation(pool, asOf, MAX_CANDIDATES), hr);
          break;
        case "contract":
          reminders = withHr(await scanContract(pool, asOf, MAX_CANDIDATES), hr);
          break;
        case "document":
          reminders = withHr(await scanDocuments(pool, asOf, null, null, MAX_CANDIDATES), hr);
          break;
        case "identity":
          reminders = withHr(await scanIdentityDocuments(pool, asOf, MAX_CANDIDATES), hr);
          break;
        case "licence":
          reminders = withHr(await scanLicences(pool, asOf, null, MAX_CANDIDATES), hr);
          break;
        case "fssai":
          reminders = [
            ...withHr(await scanDocuments(pool, asOf, FSSAI_DOC_CODES, null, MAX_CANDIDATES), hr),
            ...withHr(await scanLicences(pool, asOf, FSSAI_LICENCE_KINDS, MAX_CANDIDATES), hr),
          ];
          break;
        case "fire_safety":
          reminders = [
            ...withHr(await scanDocuments(pool, asOf, FIRE_SAFETY_DOC_CODES, null, MAX_CANDIDATES), hr),
            ...withHr(await scanLicences(pool, asOf, FIRE_SAFETY_LICENCE_KINDS, MAX_CANDIDATES), hr),
          ];
          break;
        case "insurance":
          // No insurance document type is seeded (migration 045); this matches by
          // name so adding one is a data change, not a redeploy.
          reminders = withHr(
            await scanDocuments(pool, asOf, null, "%insurance%", MAX_CANDIDATES),
            hr,
          );
          break;
        case "compoff":
          reminders = await scanCompOff(pool, asOf, MAX_CANDIDATES);
          break;
        case "leave_lapse":
          reminders = await scanLeaveLapse(pool, asOf, leaveYear, MAX_CANDIDATES);
          break;
        case "celebration":
          reminders = await scanCelebrations(pool, asOf, isLeapYear, MAX_CANDIDATES);
          break;
        case "roster":
          reminders = withHr(await scanRoster(pool, nextMonday, companyId, MAX_CANDIDATES), hr);
          break;
      }
      perClass[name] = { candidates: reminders.length, queued: 0 };
      batches.push({ name, reminders });
    }

    // ── STEP 9/10 · One transaction: context, notification writes, audit ─────
    let totalQueued = 0;
    if (!body.dry_run) {
      await withContext(ctx, async (tx) => {
        for (const batch of batches) {
          const remaining = body.limit - totalQueued;
          if (remaining <= 0) break;
          const queued = await enqueue(tx, batch.reminders, remaining);
          const bucket = perClass[batch.name];
          if (bucket !== undefined) bucket.queued = queued;
          totalQueued += queued;
        }
      });
    }

    const stats = {
      as_of: asOf,
      classes,
      leave_year: leaveYear,
      next_monday: nextMonday,
      per_class: perClass,
      notifications_queued: totalQueued,
      limit_reached: totalQueued >= body.limit,
      hr_recipients: hr.length,
    };

    if (jobRunId !== null) {
      await withContext(ctx, async (tx) => {
        await tx`
          SELECT app.job_end(
                   ${jobRunId}::uuid,
                   'succeeded'::public.job_run_status,
                   ${totalQueued}::integer,
                   0::integer,
                   ${JSON.stringify(stats)}::jsonb,
                   NULL)
        `;
        // `notifications` is not trigger-audited (038), so this is how the sweep
        // appears on the hash chain.
        await auditJobRun(tx, ctx, { jobCode, runId: jobRunId, outcome: "succeeded", stats });
      });
    }

    status = 200;
    responseBody = { job_code: jobCode, job_run_id: jobRunId, dry_run: body.dry_run, ...stats, requestId };

    // ── STEP 11 · Store the response under the idempotency key ──────────────
    if (idempotencyKey !== null) await store(idempotencyKey, status, responseBody);
    log.info("expiry reminders finished", {
      classes: classes.join(","),
      as_of: asOf,
      queued: totalQueued,
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
    if (jobRunId !== null) {
      try {
        await sql()`
          SELECT app.job_end(${jobRunId}::uuid, 'failed'::public.job_run_status, NULL, NULL, NULL,
                             ${`${problem.code ?? "ERROR"}: ${problem.problem.title}`}::text)
        `;
      } catch (jobErr) {
        log.warn("could not close job run", { err: jobErr });
      }
    }

    if (problem.isServerFault) log.error("expiry reminders failed", { err, code: problem.code });
    else log.warn("expiry reminders refused", { code: problem.code, status });
    return problem.toResponse(cors);
  } finally {
    // ── STEP 12 · One structured log line per invocation ────────────────────
    log.finish(status, { idempotency_key: idempotencyKey, job_run_id: jobRunId, job_code: jobCode });
  }
});

/** Exported so `supabase/tests` asserts against one schema and one set of windows. */
export {
  CLASSES,
  classesFromQuery,
  COMP_OFF_WINDOWS,
  CONTRACT_WINDOWS,
  DEFAULT_EXPIRY_WINDOWS,
  PROBATION_ESCALATE_AFTER_DAYS,
  PROBATION_WINDOWS,
  RemindersBody,
  whenPhrase,
};
