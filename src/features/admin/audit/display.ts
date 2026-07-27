/**
 * display.ts — turning one `audit_log` row into something a person can read.
 *
 * Three jobs, all pure, no React, no network:
 *
 *  1. **Vocabulary.** `action`, `entity_table`, `field_name`, `actor_source` and
 *     `access_kind` arrive as machine tokens. D-10/11 forbids putting any of them
 *     on screen raw (`SinglePunch`, `Date_Dt`, `None1` are the reference
 *     product's defects). Known tokens get an authored label; unknown ones get a
 *     humanised one (`employee_salary_revisions` → "Salary revision"), which is a
 *     derived English phrase rather than a column name. It is never the token.
 *
 *  2. **A plain-language sentence.** §13.2 asks each timeline row to read as a
 *     sentence, not a tuple. The sentence is assembled from the row's own fields
 *     — no template registry table is deployed (`audit_action_registry` is
 *     specified in §13.9 but not in the migrations), so the shape is derived from
 *     `action` + `entity_table` + `field_name`.
 *
 *  3. **Type-aware values.** `old_value` / `new_value` are `jsonb`, so a paise
 *     amount, a date, an enum and a whole object all arrive as `unknown`. The
 *     TYPE is inferred from the FIELD NAME, which is the only signal the row
 *     carries: `_paise` is integer money (`lib/money`), `_minutes` is a duration,
 *     `_at` is an instant, `_date`/`date_of_*` is a civil date, booleans are
 *     Yes/No. Everything else is text. NO arithmetic happens here beyond the
 *     delta between two amounts the row itself carries, which §13.3 asks for
 *     explicitly ("₹24,000.00→₹26,500.00 (+₹2,500.00)") and which is a
 *     difference of two audited values, not a re-derivation of a business figure.
 */
import { fmtCivilDate, fmtDateTime, fmtDurationHm } from "@/lib/datetime";
import { formatPaise } from "@/lib/money";
import { EM_DASH, formatNumber } from "@/lib/format";
import type { StatusChipEntry, StatusTone } from "@/shared/ui/StatusChip";
import { t, type MessageKey } from "@/shared/i18n/en";

// -----------------------------------------------------------------------------
// Humanising a snake_case token — the fallback, never the first choice
// -----------------------------------------------------------------------------

const ACRONYMS: Readonly<Record<string, string>> = {
  id: "ID",
  ids: "IDs",
  pan: "PAN",
  uan: "UAN",
  pf: "PF",
  esi: "ESI",
  esic: "ESIC",
  ifsc: "IFSC",
  ctc: "CTC",
  ot: "OT",
  hra: "HRA",
  lop: "LOP",
  tds: "TDS",
  pt: "PT",
  ip: "IP",
  dob: "date of birth",
  doj: "date of joining",
  ist: "IST",
  url: "URL",
  api: "API",
  sla: "SLA",
  posh: "POSH",
  dpdp: "DPDP",
};

/**
 * `employee_salary_revisions` → `Employee salary revisions`, `pan_number` →
 * `PAN number`. Trailing `_id` / `_paise` / `_minutes` are dropped because the
 * storage unit is not part of the label — the VALUE renders in the unit.
 */
export function humanise(token: string | null | undefined): string {
  if (token === null || token === undefined || token.trim() === "") return EM_DASH;
  const stripped = token
    .trim()
    .replace(/_paise$/, "")
    .replace(/_minutes$/, "")
    .replace(/_id$/, "");
  const parts = (stripped === "" ? token.trim() : stripped).split(/[_\s]+/).filter((p) => p !== "");
  if (parts.length === 0) return EM_DASH;
  const words = parts.map((p) => ACRONYMS[p.toLowerCase()] ?? p.toLowerCase());
  const first = words[0] ?? "";
  // Sentence case, but never re-case an all-caps acronym ('PAN number', not
  // 'Pan number'). A multi-word expansion like 'date of birth' still gets its
  // first letter lifted, because at the head of a label it is a label.
  const head = /^[A-Z]{2,}$/.test(first) ? first : first.charAt(0).toUpperCase() + first.slice(1);
  return [head, ...words.slice(1)].join(" ");
}

// -----------------------------------------------------------------------------
// Actions — the DEPLOYED `public.audit_action` enum (migration 003), 28 values
// -----------------------------------------------------------------------------

/** Verb phrase used inside the sentence, e.g. "updated", "voided". */
const ACTION_VERB: Readonly<Record<string, MessageKey>> = {
  insert: "adminAudit.verb.insert",
  update: "adminAudit.verb.update",
  delete: "adminAudit.verb.delete",
  soft_delete: "adminAudit.verb.soft_delete",
  restore: "adminAudit.verb.restore",
  hard_delete: "adminAudit.verb.hard_delete",
  login: "adminAudit.verb.login",
  logout: "adminAudit.verb.logout",
  login_failed: "adminAudit.verb.login_failed",
  read_sensitive: "adminAudit.verb.read_sensitive",
  export: "adminAudit.verb.export",
  approve: "adminAudit.verb.approve",
  reject: "adminAudit.verb.reject",
  cancel: "adminAudit.verb.cancel",
  void: "adminAudit.verb.void",
  override: "adminAudit.verb.override",
  recompute: "adminAudit.verb.recompute",
  lock: "adminAudit.verb.lock",
  unlock: "adminAudit.verb.unlock",
  send: "adminAudit.verb.send",
  sign: "adminAudit.verb.sign",
  enrol_biometric: "adminAudit.verb.enrol_biometric",
  purge_biometric: "adminAudit.verb.purge_biometric",
  grant_role: "adminAudit.verb.grant_role",
  revoke_role: "adminAudit.verb.revoke_role",
  impersonate: "adminAudit.verb.impersonate",
  config_change: "adminAudit.verb.config_change",
  job_run: "adminAudit.verb.job_run",
};

/** Noun label for the action filter chips and the Action column. */
const ACTION_LABEL: Readonly<Record<string, MessageKey>> = {
  insert: "adminAudit.action.insert",
  update: "adminAudit.action.update",
  delete: "adminAudit.action.delete",
  soft_delete: "adminAudit.action.soft_delete",
  restore: "adminAudit.action.restore",
  hard_delete: "adminAudit.action.hard_delete",
  login: "adminAudit.action.login",
  logout: "adminAudit.action.logout",
  login_failed: "adminAudit.action.login_failed",
  read_sensitive: "adminAudit.action.read_sensitive",
  export: "adminAudit.action.export",
  approve: "adminAudit.action.approve",
  reject: "adminAudit.action.reject",
  cancel: "adminAudit.action.cancel",
  void: "adminAudit.action.void",
  override: "adminAudit.action.override",
  recompute: "adminAudit.action.recompute",
  lock: "adminAudit.action.lock",
  unlock: "adminAudit.action.unlock",
  send: "adminAudit.action.send",
  sign: "adminAudit.action.sign",
  enrol_biometric: "adminAudit.action.enrol_biometric",
  purge_biometric: "adminAudit.action.purge_biometric",
  grant_role: "adminAudit.action.grant_role",
  revoke_role: "adminAudit.action.revoke_role",
  impersonate: "adminAudit.action.impersonate",
  config_change: "adminAudit.action.config_change",
  job_run: "adminAudit.action.job_run",
};

/**
 * §13.1 severity, expressed as the tone of the leading dot. Not stored on the
 * row (`audit_log` has no `severity` column in the deployed schema), so it is
 * derived from the action — which is exactly what `audit_action_registry` would
 * carry if it were deployed.
 */
const ACTION_TONE: Readonly<Record<string, StatusTone>> = {
  hard_delete: "danger",
  purge_biometric: "danger",
  impersonate: "danger",
  unlock: "danger",
  login_failed: "danger",
  delete: "danger",
  override: "warn",
  soft_delete: "warn",
  grant_role: "warn",
  revoke_role: "warn",
  read_sensitive: "warn",
  export: "warn",
  reject: "warn",
  void: "warn",
  config_change: "warn",
  lock: "info",
  restore: "info",
  recompute: "info",
  approve: "success",
  sign: "success",
  enrol_biometric: "success",
  insert: "info",
  update: "neutral",
  login: "neutral",
  logout: "neutral",
  cancel: "neutral",
  send: "neutral",
  job_run: "neutral",
};

export function actionLabel(action: string): string {
  const key = ACTION_LABEL[action];
  return key !== undefined ? t(key) : humanise(action);
}

export function actionVerb(action: string): string {
  const key = ACTION_VERB[action];
  return key !== undefined ? t(key) : humanise(action).toLowerCase();
}

export function actionTone(action: string): StatusTone {
  return ACTION_TONE[action] ?? "neutral";
}

/** A one-entry chip map, so StatusChip never falls back to a raw token. */
export function actionChip(action: string): Record<string, StatusChipEntry> {
  return { [action]: { label: actionLabel(action), tone: actionTone(action) } };
}

/** True for the actions §13.9 marks sensitive or critical — the ones to watch. */
export function isSensitiveAction(action: string): boolean {
  const tone = actionTone(action);
  return tone === "danger" || tone === "warn";
}

// -----------------------------------------------------------------------------
// Entities — authored labels for the tables the audit engine actually writes
// -----------------------------------------------------------------------------

const ENTITY_LABEL: Readonly<Record<string, MessageKey>> = {
  employees: "adminAudit.entity.employees",
  attendance_days: "adminAudit.entity.attendance_days",
  attendance_punches: "adminAudit.entity.attendance_punches",
  attendance_lock_periods: "adminAudit.entity.attendance_lock_periods",
  attendance_regularizations: "adminAudit.entity.attendance_regularizations",
  employee_statutory: "adminAudit.entity.employee_statutory",
  employee_bank_accounts: "adminAudit.entity.employee_bank_accounts",
  employee_salary_revisions: "adminAudit.entity.employee_salary_revisions",
  user_roles: "adminAudit.entity.user_roles",
  settings: "adminAudit.entity.settings",
  feature_flags: "adminAudit.entity.feature_flags",
  leave_types: "adminAudit.entity.leave_types",
  leave_requests: "adminAudit.entity.leave_requests",
  leave_ledger: "adminAudit.entity.leave_ledger",
  documents: "adminAudit.entity.documents",
  payroll_runs: "adminAudit.entity.payroll_runs",
  pay_periods: "adminAudit.entity.pay_periods",
  holidays: "adminAudit.entity.holidays",
  departments: "adminAudit.entity.departments",
  shifts: "adminAudit.entity.shifts",
  kiosk_devices: "adminAudit.entity.kiosk_devices",
  face_templates: "adminAudit.entity.face_templates",
  profiles: "adminAudit.entity.profiles",
  rosters: "adminAudit.entity.rosters",
  payslips: "adminAudit.entity.payslips",
};

export function entityLabel(entityTable: string): string {
  const key = ENTITY_LABEL[entityTable];
  return key !== undefined ? t(key) : humanise(entityTable);
}

/** The tables the entity filter offers, in the order an auditor thinks of them. */
export const AUDITED_ENTITY_TABLES: readonly string[] = Object.keys(ENTITY_LABEL);

/** Field label: authored where it matters, humanised otherwise. */
export function fieldLabel(fieldName: string | null | undefined): string {
  if (fieldName === null || fieldName === undefined || fieldName === "") return EM_DASH;
  return humanise(fieldName);
}

// -----------------------------------------------------------------------------
// Actor source + role
// -----------------------------------------------------------------------------

/**
 * `public.actor_source` — the DEPLOYED enum (migration 003), verbatim. §13.1
 * lists `mobile`, `api` and `system_trigger`; none of those are enum members
 * here, and filtering on one returns 22P02, so they are deliberately absent.
 */
const SOURCE_LABEL: Readonly<Record<string, MessageKey>> = {
  web_admin: "adminAudit.source.web_admin",
  web_employee: "adminAudit.source.web_employee",
  web_manager: "adminAudit.source.web_manager",
  kiosk: "adminAudit.source.kiosk",
  edge_function: "adminAudit.source.edge_function",
  cron: "adminAudit.source.cron",
  import: "adminAudit.source.import",
  ai_agent: "adminAudit.source.ai_agent",
  service_role: "adminAudit.source.service_role",
  migration: "adminAudit.source.migration",
};

/** The values the source filter may send. Anything else is a 22P02. */
export const ACTOR_SOURCE_VALUES: readonly string[] = Object.keys(SOURCE_LABEL);

export function sourceLabel(source: string | null | undefined): string {
  if (source === null || source === undefined || source === "") return EM_DASH;
  const key = SOURCE_LABEL[source];
  return key !== undefined ? t(key) : humanise(source);
}

/** `public.app_role` — four members only; `kiosk_operator` is a capability. */
const ROLE_LABEL: Readonly<Record<string, MessageKey>> = {
  employee: "adminAudit.role.employee",
  manager: "adminAudit.role.manager",
  admin: "adminAudit.role.admin",
  super_admin: "adminAudit.role.super_admin",
};

export const APP_ROLE_VALUES: readonly string[] = Object.keys(ROLE_LABEL);

export function roleLabel(role: string | null | undefined): string {
  if (role === null || role === undefined || role === "") return EM_DASH;
  const key = ROLE_LABEL[role];
  return key !== undefined ? t(key) : humanise(role);
}

/**
 * The actor's display name. Falls back through the identity the row actually
 * carries: a resolved profile name, then the denormalised email, then "System"
 * for a trigger/cron row that genuinely has no human behind it.
 */
export function actorLabel(opts: {
  readonly name?: string | null;
  readonly email?: string | null;
  readonly actorId?: string | null;
  readonly source?: string | null;
}): string {
  if (opts.name !== null && opts.name !== undefined && opts.name.trim() !== "") return opts.name;
  if (opts.email !== null && opts.email !== undefined && opts.email.trim() !== "") return opts.email;
  if (opts.actorId === null || opts.actorId === undefined) return t("adminAudit.actor.system");
  return t("adminAudit.actor.unknown");
}

// -----------------------------------------------------------------------------
// Type-aware values
// -----------------------------------------------------------------------------

export type AuditValueKind =
  | "money"
  | "duration"
  | "instant"
  | "date"
  | "boolean"
  | "number"
  | "json"
  | "text"
  | "empty";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/**
 * Infer how to render a jsonb audit value. The field name is authoritative for
 * unit (`_paise`, `_minutes`); the value's own shape decides the rest.
 */
export function auditValueKind(fieldName: string | null | undefined, value: unknown): AuditValueKind {
  if (value === null || value === undefined || value === "") return "empty";
  const field = fieldName ?? "";
  if (/_paise$/.test(field)) return "money";
  if (/_minutes$/.test(field)) return "duration";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "object") return "json";
  if (typeof value === "string") {
    if (ISO_DATE.test(value)) return "date";
    if (ISO_INSTANT.test(value)) return "instant";
    return "text";
  }
  if (typeof value === "number") {
    // A bare number on an `_at`/`_date` field would be a schema surprise; treat
    // every other number as a number and let the reader see it.
    return "number";
  }
  return "text";
}

/**
 * Render one audit value as a string. `redacted` short-circuits everything: the
 * server stored `***` and the client never had the real value, so there is
 * nothing here to leak and nothing to un-mask (D-19 / §13.3).
 */
export function fmtAuditValue(
  fieldName: string | null | undefined,
  value: unknown,
  opts: { readonly redacted?: boolean } = {},
): string {
  if (opts.redacted === true) return t("adminAudit.value.redacted");
  const kind = auditValueKind(fieldName, value);
  switch (kind) {
    case "empty":
      return t("adminAudit.value.notSet");
    case "money":
      return typeof value === "number" ? formatPaise(value) : String(value);
    case "duration":
      return typeof value === "number" ? fmtDurationHm(value) : String(value);
    case "date":
      return fmtCivilDate(String(value));
    case "instant":
      return fmtDateTime(String(value));
    case "boolean":
      return value === true ? t("common.yes") : t("common.no");
    case "number":
      return String(value);
    case "json":
      return JSON.stringify(value, null, 2);
    case "text": {
      // An enum token in a jsonb value is still a token, and D-10/11 forbids
      // putting one on screen raw — `on_probation`, `active` and `SinglePunch`
      // are all the same defect. Anything that looks like a bare lowercase
      // identifier is humanised; anything with a space, capital, digit-heavy
      // shape or punctuation (a name, an email, an account number, free prose)
      // is left exactly as the database stored it.
      const s = String(value);
      return /^[a-z][a-z0-9_]*$/.test(s) ? humanise(s) : s;
    }
  }
}

/**
 * The delta line §13.3 asks for on a money change: "+₹2,500.00". It is the
 * difference of the two values ON THIS ROW — not a recomputation of anything the
 * server owns — and is returned as null whenever either side is absent, so an
 * initial-set never renders a fake "+100%".
 */
export function moneyDelta(
  fieldName: string | null | undefined,
  oldValue: unknown,
  newValue: unknown,
): string | null {
  if (auditValueKind(fieldName, oldValue) !== "money") return null;
  if (auditValueKind(fieldName, newValue) !== "money") return null;
  if (typeof oldValue !== "number" || typeof newValue !== "number") return null;
  const diff = newValue - oldValue;
  if (diff === 0) return null;
  const sign = diff > 0 ? "+" : "−";
  return `${sign}${formatPaise(Math.abs(diff))}`;
}

/** Day delta on a date change — "3 days later" reads better than two dates. */
export function dayDelta(
  fieldName: string | null | undefined,
  oldValue: unknown,
  newValue: unknown,
): string | null {
  if (auditValueKind(fieldName, oldValue) !== "date") return null;
  if (auditValueKind(fieldName, newValue) !== "date") return null;
  const a = Date.parse(`${String(oldValue)}T00:00:00Z`);
  const b = Date.parse(`${String(newValue)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const days = Math.round((b - a) / 86_400_000);
  if (days === 0) return null;
  return days > 0
    ? t("adminAudit.value.daysLater", { days })
    : t("adminAudit.value.daysEarlier", { days: Math.abs(days) });
}

/** True when this row is a first-set (`—` → value), which §13.3 labels "Set". */
export function isFirstSet(oldValue: unknown, newValue: unknown): boolean {
  const wasEmpty = oldValue === null || oldValue === undefined || oldValue === "";
  const nowHas = newValue !== null && newValue !== undefined && newValue !== "";
  return wasEmpty && nowHas;
}

// -----------------------------------------------------------------------------
// The plain-language sentence (§13.2)
// -----------------------------------------------------------------------------

export interface SentenceInput {
  readonly action: string;
  readonly entity_table: string;
  readonly entity_label: string | null;
  readonly field_name: string | null;
  readonly actorName: string;
}

/**
 * "Priya Nair changed Monthly gross on TT0003 — Ravi Kumar."
 *
 * The entity's own denormalised label is preferred; where the trigger did not
 * populate one, the entity type stands in ("a Salary revision"). Never a uuid:
 * an id in a sentence is a tuple wearing a sentence's clothes.
 */
export function auditSentence(row: SentenceInput): string {
  const subject = row.entity_label !== null && row.entity_label.trim() !== ""
    ? row.entity_label
    : entityLabel(row.entity_table);
  const verb = actionVerb(row.action);
  if (row.field_name !== null && row.field_name !== "") {
    return t("adminAudit.sentence.withField", {
      actor: row.actorName,
      verb,
      field: fieldLabel(row.field_name),
      subject,
    });
  }
  return t("adminAudit.sentence.withoutField", { actor: row.actorName, verb, subject });
}

// -----------------------------------------------------------------------------
// Session, data-access and export vocabularies
// -----------------------------------------------------------------------------

const SESSION_EVENT: Readonly<Record<string, { key: MessageKey; tone: StatusTone }>> = {
  login_success: { key: "adminAudit.session.login_success", tone: "success" },
  login_failed: { key: "adminAudit.session.login_failed", tone: "danger" },
  logout: { key: "adminAudit.session.logout", tone: "neutral" },
  token_refresh: { key: "adminAudit.session.token_refresh", tone: "neutral" },
  password_reset_requested: { key: "adminAudit.session.password_reset_requested", tone: "warn" },
  password_changed: { key: "adminAudit.session.password_changed", tone: "warn" },
  passkey_registered: { key: "adminAudit.session.passkey_registered", tone: "info" },
  passkey_used: { key: "adminAudit.session.passkey_used", tone: "success" },
  mfa_challenge: { key: "adminAudit.session.mfa_challenge", tone: "info" },
  session_revoked: { key: "adminAudit.session.session_revoked", tone: "danger" },
};

export function sessionEventChip(event: string): Record<string, StatusChipEntry> {
  const entry = SESSION_EVENT[event];
  return {
    [event]: entry !== undefined
      ? { label: t(entry.key), tone: entry.tone }
      : { label: humanise(event), tone: "neutral" },
  };
}

export function sessionEventLabel(event: string): string {
  const entry = SESSION_EVENT[event];
  return entry !== undefined ? t(entry.key) : humanise(event);
}

const AUTH_METHOD: Readonly<Record<string, MessageKey>> = {
  password: "adminAudit.authMethod.password",
  passkey: "adminAudit.authMethod.passkey",
  magic_link: "adminAudit.authMethod.magic_link",
  otp: "adminAudit.authMethod.otp",
  kiosk_pin: "adminAudit.authMethod.kiosk_pin",
};

export function authMethodLabel(method: string | null | undefined): string {
  if (method === null || method === undefined || method === "") return EM_DASH;
  const key = AUTH_METHOD[method];
  return key !== undefined ? t(key) : humanise(method);
}

/**
 * `data_access_log.access_kind` — the DEPLOYED `ck_dalog__kind` vocabulary is
 * `reveal | export | report | ai_query | bulk_view`. §13.5 describes a wider set
 * (viewed/revealed/downloaded/printed/emailed); those values would violate the
 * CHECK constraint, so the filter offers what the database will actually store.
 */
const ACCESS_KIND: Readonly<Record<string, { key: MessageKey; tone: StatusTone }>> = {
  reveal: { key: "adminAudit.accessKind.reveal", tone: "warn" },
  export: { key: "adminAudit.accessKind.export", tone: "danger" },
  report: { key: "adminAudit.accessKind.report", tone: "info" },
  ai_query: { key: "adminAudit.accessKind.ai_query", tone: "info" },
  bulk_view: { key: "adminAudit.accessKind.bulk_view", tone: "warn" },
};

export const ACCESS_KIND_VALUES: readonly string[] = Object.keys(ACCESS_KIND);

export function accessKindChip(kind: string): Record<string, StatusChipEntry> {
  const entry = ACCESS_KIND[kind];
  return {
    [kind]: entry !== undefined
      ? { label: t(entry.key), tone: entry.tone }
      : { label: humanise(kind), tone: "neutral" },
  };
}

export function accessKindLabel(kind: string): string {
  const entry = ACCESS_KIND[kind];
  return entry !== undefined ? t(entry.key) : humanise(kind);
}

/**
 * The sensitive fields §13.5 enumerates, as the picker offers them. These are
 * the values `data_access_log.fields` actually receives from the reveal RPCs
 * (`app.log_reveal()` passes the column names it exposed).
 */
export function fieldsSummary(fields: readonly string[]): string {
  if (fields.length === 0) return EM_DASH;
  return fields.map((f) => fieldLabel(f)).join(", ");
}

const EXPORT_KIND: Readonly<Record<string, MessageKey>> = {
  csv: "adminAudit.exportKind.csv",
  xlsx: "adminAudit.exportKind.xlsx",
  pdf: "adminAudit.exportKind.pdf",
  bank_advice: "adminAudit.exportKind.bank_advice",
  audit_dump: "adminAudit.exportKind.audit_dump",
  api_bulk: "adminAudit.exportKind.api_bulk",
  ai_infographic_data: "adminAudit.exportKind.ai_infographic_data",
};

export function exportKindLabel(kind: string): string {
  const key = EXPORT_KIND[kind];
  return key !== undefined ? t(key) : humanise(kind);
}

const EXPORT_SUBJECT: Readonly<Record<string, MessageKey>> = {
  employees: "adminAudit.exportSubject.employees",
  attendance: "adminAudit.exportSubject.attendance",
  payroll: "adminAudit.exportSubject.payroll",
  audit_log: "adminAudit.exportSubject.audit_log",
  documents: "adminAudit.exportSubject.documents",
  leave: "adminAudit.exportSubject.leave",
  assets: "adminAudit.exportSubject.assets",
  face_match_log: "adminAudit.exportSubject.face_match_log",
};

export function exportSubjectLabel(subject: string): string {
  const key = EXPORT_SUBJECT[subject];
  return key !== undefined ? t(key) : humanise(subject);
}

/** The three sensitivity flags as one readable phrase, or "—" when clean. */
export function sensitivitySummary(row: {
  readonly contains_pii: boolean;
  readonly contains_salary: boolean;
  readonly contains_biometric: boolean;
}): string {
  const parts: string[] = [];
  if (row.contains_pii) parts.push(t("adminAudit.exports.flag.pii"));
  if (row.contains_salary) parts.push(t("adminAudit.exports.flag.salary"));
  if (row.contains_biometric) parts.push(t("adminAudit.exports.flag.biometric"));
  return parts.length === 0 ? EM_DASH : parts.join(" · ");
}

/** File size in the unit a person reads. Presentation only. */
export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return EM_DASH;
  if (bytes < 1024) return t("adminAudit.exports.bytes", { n: bytes });
  if (bytes < 1024 * 1024) return t("adminAudit.exports.kb", { n: (bytes / 1024).toFixed(1) });
  return t("adminAudit.exports.mb", { n: (bytes / (1024 * 1024)).toFixed(1) });
}

// -----------------------------------------------------------------------------
// Integrity
// -----------------------------------------------------------------------------

/** `audit_seals.verification_result` — the values `cron-integrity` writes. */
const VERIFICATION: Readonly<Record<string, { key: MessageKey; tone: StatusTone }>> = {
  ok: { key: "adminAudit.integrity.result.ok", tone: "success" },
  chain_broken: { key: "adminAudit.integrity.result.chain_broken", tone: "danger" },
  not_verified: { key: "adminAudit.integrity.result.not_verified", tone: "warn" },
};

export function verificationChip(result: string | null): Record<string, StatusChipEntry> {
  const key = result ?? "not_verified";
  const entry = VERIFICATION[key];
  return {
    [key]: entry !== undefined
      ? { label: t(entry.key), tone: entry.tone }
      : { label: humanise(key), tone: "neutral" },
  };
}

export function verificationTone(result: string | null): StatusTone {
  return VERIFICATION[result ?? "not_verified"]?.tone ?? "neutral";
}

/** A 64-hex hash, grouped so a human can compare it against a printed copy. */
export function groupHash(hash: string | null | undefined): string {
  if (hash === null || hash === undefined || hash === "") return EM_DASH;
  return hash.replace(/(.{8})/g, "$1 ").trim();
}

/** First 12 characters — enough to recognise, short enough for a grid cell. */
export function shortHash(hash: string | null | undefined): string {
  if (hash === null || hash === undefined || hash === "") return EM_DASH;
  return hash.slice(0, 12);
}

// -----------------------------------------------------------------------------
// Keyset list counts
// -----------------------------------------------------------------------------

/**
 * The count that goes in a filter bar. `paginate()` learns `hasMore` from
 * `pageSize + 1` rows and never issues a COUNT, so this console genuinely does
 * not know how many events match — and printing "1–50 of 1,347" for a table that
 * is being appended to would be the reference product's dashboard-disagrees-with-
 * its-own-detail defect in a new place. It says what it knows: how many are
 * loaded, and whether there are more.
 */
export function loadedLabel(loadedCount: number, hasNextPage: boolean): string {
  return hasNextPage
    ? t("adminAudit.list.countMore", { n: formatNumber(loadedCount) })
    : t("adminAudit.list.count", { n: formatNumber(loadedCount) });
}
