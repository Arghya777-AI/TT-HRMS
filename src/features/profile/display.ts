/**
 * display.ts — server codes → sentences a person can read.
 *
 * This is where DR-53 and DR-60 are actually paid for. Every function takes a
 * policy ROW and returns prose; no component may print `single_punch_treatment`,
 * `WO-SUN-ALTSAT`, `PP001` or `first_off_weeks = {1,2,4}`. Durations go out
 * through `fmtDuration`, dates through `fmtCivilDate`, times through
 * `fmtCivilTime` — never a bare minute count and never a 12-hour clock.
 *
 * Nothing here computes a business number. `fmtDuration(shift.duration_minutes)`
 * formats a server column; it does not derive "net hours" by subtracting breaks.
 */
import { fmtCivilDate, fmtCivilTime, fmtDuration } from "@/lib/datetime";
import { dash } from "@/lib/format";
import { t, type MessageKey } from "@/shared/i18n/en";
import type {
  AttendancePolicy,
  PayPeriod,
  Shift,
  WeeklyOffRule,
} from "./api/employment.api";
import type {
  BloodGroup,
  EmploymentStatus,
  EmploymentType,
  Gender,
  MaritalStatus,
  PaymentMode,
} from "./api/profile.api";
import type { LifecycleEvent } from "./api/history.api";
import type { CustomFieldRow } from "./api/custom-fields.api";

// -----------------------------------------------------------------------------
// Weekdays — DOW 0 = Sunday, per the weekly_off_rules seed comment
// -----------------------------------------------------------------------------

const DOW_KEY: readonly MessageKey[] = [
  "profile.dow.sunday",
  "profile.dow.monday",
  "profile.dow.tuesday",
  "profile.dow.wednesday",
  "profile.dow.thursday",
  "profile.dow.friday",
  "profile.dow.saturday",
];

function dowName(dow: number | null): string | null {
  if (dow === null || dow < 0 || dow > 6) return null;
  const key = DOW_KEY[dow];
  return key === undefined ? null : t(key);
}

const ORDINAL_KEY: readonly MessageKey[] = [
  "profile.ordinal.1",
  "profile.ordinal.2",
  "profile.ordinal.3",
  "profile.ordinal.4",
  "profile.ordinal.5",
];

function ordinal(week: number): string {
  const key = ORDINAL_KEY[week - 1];
  return key === undefined ? String(week) : t(key);
}

/** "1st and 3rd" / "2nd, 4th and 5th" — an ICU-free list join via t(). */
function joinOrdinals(weeks: readonly number[]): string {
  const parts = [...weeks].sort((a, b) => a - b).map(ordinal);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  const head = parts.slice(0, -1).join(", ");
  return t("profile.list.and", { head, last });
}

const EVERY_WEEK = new Set([1, 2, 3, 4, 5]);

function isEveryWeek(weeks: readonly number[] | null): boolean {
  if (weeks === null || weeks.length === 0) return true;
  if (weeks.length < 5) return false;
  return weeks.every((w) => EVERY_WEEK.has(w));
}

/** "Sunday every week" / "2nd and 4th Saturday". One clause per off-day (DR-60). */
function offDayClause(dow: number | null, weeks: readonly number[] | null): string | null {
  const day = dowName(dow);
  if (day === null) return null;
  if (isEveryWeek(weeks)) return t("profile.weeklyOff.everyWeek", { day });
  return t("profile.weeklyOff.someWeeks", { weeks: joinOrdinals(weeks ?? []), day });
}

/**
 * The weekly-off rule as ONE sentence, grouped per off-day.
 *
 * The reference product printed two rows of "Weeks 1,2,3,4,5" under ambiguous
 * labels and left the employee to work out which days were actually off.
 */
export function weeklyOffSentence(rule: WeeklyOffRule | null): string {
  if (rule === null) return t("profile.weeklyOff.none");

  if (rule.rule_kind === "roster_driven") {
    return rule.offs_per_week !== null
      ? t("profile.weeklyOff.roster", { count: rule.offs_per_week })
      : t("profile.weeklyOff.rosterNoFloor");
  }

  if (rule.rule_kind === "days_per_week") {
    return rule.offs_per_week !== null
      ? t("profile.weeklyOff.perWeek", { count: rule.offs_per_week })
      : t("profile.weeklyOff.rosterNoFloor");
  }

  if (rule.rule_kind === "rotational" || rule.is_rotational) {
    return rule.rotation_anchor_date !== null
      ? t("profile.weeklyOff.rotationalAnchored", {
          date: fmtCivilDate(rule.rotation_anchor_date),
        })
      : t("profile.weeklyOff.rotational");
  }

  const clauses = [
    offDayClause(rule.first_off_dow, rule.first_off_weeks),
    offDayClause(rule.second_off_dow, rule.second_off_weeks),
    offDayClause(rule.third_off_dow, rule.third_off_weeks),
  ].filter((c): c is string => c !== null);

  if (clauses.length === 0) return t("profile.weeklyOff.unspecified");

  const sentence = clauses.length === 1
    ? clauses[0] ?? ""
    : t("profile.list.plus", {
        head: clauses.slice(0, -1).join(t("profile.list.plusSeparator")),
        last: clauses[clauses.length - 1] ?? "",
      });

  const half = dowName(rule.half_day_dow);
  return half === null ? sentence : t("profile.weeklyOff.withHalfDay", { sentence, day: half });
}

// -----------------------------------------------------------------------------
// Shift
// -----------------------------------------------------------------------------

/** "General · 09:30 to 18:30" — name plus 24h window, never the bare code. */
export function shiftWindow(shift: Shift | null): string {
  if (shift === null) return t("profile.shift.none");
  const window = t("profile.shift.window", {
    from: fmtCivilTime(shift.start_time),
    to: fmtCivilTime(shift.end_time),
  });
  return shift.crosses_midnight
    ? t("profile.shift.crossesMidnight", { name: shift.name, window })
    : t("profile.shift.named", { name: shift.name, window });
}

/** The shift's own rules, in words: paid span, break, grace. */
export function shiftRulesSentence(shift: Shift | null): string {
  if (shift === null) return t("profile.shift.none");
  return t("profile.shift.rules", {
    duration: fmtDuration(shift.duration_minutes),
    break: fmtDuration(shift.unpaid_break_minutes),
    graceIn: fmtDuration(shift.grace_in_minutes),
    graceOut: fmtDuration(shift.grace_out_minutes),
  });
}

// -----------------------------------------------------------------------------
// Attendance policy
// -----------------------------------------------------------------------------

const SINGLE_PUNCH_KEY = {
  absent: "profile.singlePunch.absent",
  half_day: "profile.singlePunch.halfDay",
  present_flag_review: "profile.singlePunch.presentReview",
  half_day_flag_review: "profile.singlePunch.halfDayReview",
} as const;

/** What happens when only one scan is recorded for a day. */
export function singlePunchSentence(policy: AttendancePolicy | null): string {
  if (policy === null) return t("profile.policy.none");
  return t(SINGLE_PUNCH_KEY[policy.single_punch_treatment]);
}

/**
 * The late rule, spelled out with the policy's own thresholds.
 * `late_deduction_leave_days` is a server column (0.500), not a client fraction.
 */
export function latePolicySentence(policy: AttendancePolicy | null): string {
  if (policy === null) return t("profile.policy.none");
  return t("profile.late.sentence", {
    grace: fmtDuration(policy.grace_in_minutes),
    free: policy.max_late_days_before_deduction,
    days: policy.late_deduction_leave_days.toFixed(1),
    period:
      policy.late_deduction_reset_period === "calendar_month"
        ? t("profile.late.resetMonth")
        : t("profile.late.resetPayPeriod"),
  });
}

/** The early-exit grace, stated separately so the two graces are not conflated. */
export function earlyExitSentence(policy: AttendancePolicy | null): string {
  if (policy === null) return t("profile.policy.none");
  return t("profile.early.sentence", { grace: fmtDuration(policy.grace_out_minutes) });
}

const EXTRA_WORK_KEY = {
  comp_off: "profile.extraWork.compOff",
  paid: "profile.extraWork.paid",
  both: "profile.extraWork.both",
  none: "profile.extraWork.none",
} as const;

/** Overtime and extra-work handling, in words. */
export function overtimeSentence(policy: AttendancePolicy | null): string {
  if (policy === null) return t("profile.policy.none");
  if (!policy.overtime_enabled) return t("profile.overtime.disabled");
  return t(
    policy.overtime_requires_approval
      ? "profile.overtime.approvalNeeded"
      : "profile.overtime.automatic",
    { min: fmtDuration(policy.overtime_min_minutes) },
  );
}

export function extraWorkSentence(policy: AttendancePolicy | null): string {
  if (policy === null) return t("profile.policy.none");
  const base = t(EXTRA_WORK_KEY[policy.extra_work_compensation]);
  if (policy.extra_work_compensation === "none") return base;
  return t("profile.extraWork.thresholds", {
    base,
    half: fmtDuration(policy.comp_off_min_minutes),
    full: fmtDuration(policy.comp_off_full_day_minutes),
    expiry: policy.comp_off_expiry_days,
  });
}

/** The correction window and monthly cap, so E-04's limits are discoverable. */
export function regularizationSentence(policy: AttendancePolicy | null): string {
  if (policy === null) return t("profile.policy.none");
  return t("profile.regularization.sentence", {
    days: policy.regularization_window_days,
    cap: policy.max_regularizations_per_month,
  });
}

// -----------------------------------------------------------------------------
// Pay period
// -----------------------------------------------------------------------------

/**
 * The pay period in plain language, cutoff stated.
 *
 * `pay_periods.name` is already human in this database ("July 2026
 * (26 Jun – 25 Jul)"), so the code (`2026-07`) is never rendered — and the
 * cutoff appears as its own line, which is the DR-34 fix: days after the cutoff
 * are arrears on the NEXT payslip, not a 25-day month.
 */
export function payPeriodSentence(period: PayPeriod | null): string {
  if (period === null) return t("profile.payPeriod.none");
  return t("profile.payPeriod.sentence", {
    name: period.name,
    from: fmtCivilDate(period.start_date),
    to: fmtCivilDate(period.end_date),
  });
}

export function payPeriodCutoffSentence(period: PayPeriod | null): string {
  if (period === null) return t("profile.payPeriod.none");
  return t("profile.payPeriod.cutoff", {
    cutoff: fmtCivilDate(period.attendance_cutoff_date),
    payDate: fmtCivilDate(period.pay_date),
  });
}

/** "Actual days in the month (28–31)" — never a fixed-30 fiction unless set. */
export function monthDaysBasisSentence(period: PayPeriod | null): string {
  if (period === null) return t("profile.payPeriod.none");
  switch (period.month_days_basis) {
    case "actual":
      return t("profile.payPeriod.basisActual");
    case "fixed_30":
      return t("profile.payPeriod.basisFixed30");
    case "fixed_26":
      return t("profile.payPeriod.basisFixed26");
  }
}

// -----------------------------------------------------------------------------
// Employee enums
// -----------------------------------------------------------------------------

const EMPLOYMENT_TYPE_KEY = {
  permanent: "profile.employmentType.permanent",
  probation: "profile.employmentType.probation",
  contract: "profile.employmentType.contract",
  intern: "profile.employmentType.intern",
  consultant: "profile.employmentType.consultant",
  casual: "profile.employmentType.casual",
  apprentice: "profile.employmentType.apprentice",
  retainer: "profile.employmentType.retainer",
} as const;

export function employmentTypeLabel(value: EmploymentType): string {
  return t(EMPLOYMENT_TYPE_KEY[value]);
}

const EMPLOYMENT_STATUS_KEY = {
  pre_joining: "profile.employmentStatus.preJoining",
  active: "profile.employmentStatus.active",
  on_probation: "profile.employmentStatus.onProbation",
  confirmed: "profile.employmentStatus.confirmed",
  on_notice: "profile.employmentStatus.onNotice",
  suspended: "profile.employmentStatus.suspended",
  on_long_leave: "profile.employmentStatus.onLongLeave",
  absconding: "profile.employmentStatus.absconding",
  exited: "profile.employmentStatus.exited",
  retired: "profile.employmentStatus.retired",
  rehired: "profile.employmentStatus.rehired",
} as const;

export function employmentStatusLabel(value: EmploymentStatus): string {
  return t(EMPLOYMENT_STATUS_KEY[value]);
}

const GENDER_KEY = {
  male: "profile.gender.male",
  female: "profile.gender.female",
  transgender: "profile.gender.transgender",
  prefer_not_to_say: "profile.gender.preferNotToSay",
} as const;

export function genderLabel(value: Gender | null): string {
  return value === null ? dash(null) : t(GENDER_KEY[value]);
}

const MARITAL_STATUS_KEY = {
  single: "profile.marital.single",
  married: "profile.marital.married",
  divorced: "profile.marital.divorced",
  widowed: "profile.marital.widowed",
  separated: "profile.marital.separated",
} as const;

export function maritalStatusLabel(value: MaritalStatus | null): string {
  return value === null ? dash(null) : t(MARITAL_STATUS_KEY[value]);
}

/** 'unknown' is a real enum value meaning "not recorded" — render it as '—'. */
export function bloodGroupLabel(value: BloodGroup): string {
  return value === "unknown" ? dash(null) : value;
}

const PAYMENT_MODE_KEY = {
  bank_transfer: "profile.paymentMode.bankTransfer",
  cash: "profile.paymentMode.cash",
  cheque: "profile.paymentMode.cheque",
  upi: "profile.paymentMode.upi",
} as const;

export function paymentModeLabel(value: PaymentMode): string {
  return t(PAYMENT_MODE_KEY[value]);
}

// -----------------------------------------------------------------------------
// Satellite vocabularies
// -----------------------------------------------------------------------------

const ADDRESS_KIND_KEY = {
  permanent: "profile.addressKind.permanent",
  correspondence: "profile.addressKind.correspondence",
  emergency: "profile.addressKind.emergency",
  previous: "profile.addressKind.previous",
} as const;

export function addressKindLabel(kind: keyof typeof ADDRESS_KIND_KEY): string {
  return t(ADDRESS_KIND_KEY[kind]);
}

const CONTACT_KIND_KEY = {
  mobile: "profile.contactKind.mobile",
  alternate_mobile: "profile.contactKind.alternateMobile",
  residence: "profile.contactKind.residence",
  office: "profile.contactKind.office",
  office_extension: "profile.contactKind.officeExtension",
  emergency: "profile.contactKind.emergency",
  whatsapp: "profile.contactKind.whatsapp",
} as const;

export function contactKindLabel(kind: keyof typeof CONTACT_KIND_KEY): string {
  return t(CONTACT_KIND_KEY[kind]);
}

const QUALIFICATION_KIND_KEY = {
  school: "profile.qualKind.school",
  diploma: "profile.qualKind.diploma",
  graduate: "profile.qualKind.graduate",
  post_graduate: "profile.qualKind.postGraduate",
  doctorate: "profile.qualKind.doctorate",
  certification: "profile.qualKind.certification",
  licence: "profile.qualKind.licence",
} as const;

export function qualificationKindLabel(kind: keyof typeof QUALIFICATION_KIND_KEY): string {
  return t(QUALIFICATION_KIND_KEY[kind]);
}

const ID_DOCUMENT_KIND_KEY = {
  aadhaar: "profile.idKind.aadhaar",
  pan: "profile.idKind.pan",
  passport: "profile.idKind.passport",
  visa: "profile.idKind.visa",
  driving_licence: "profile.idKind.drivingLicence",
  voter_id: "profile.idKind.voterId",
  ration_card: "profile.idKind.rationCard",
  other: "profile.idKind.other",
} as const;

export function idDocumentKindLabel(kind: keyof typeof ID_DOCUMENT_KIND_KEY): string {
  return t(ID_DOCUMENT_KIND_KEY[kind]);
}

const RELATIONSHIP_KEY = {
  spouse: "profile.relation.spouse",
  son: "profile.relation.son",
  daughter: "profile.relation.daughter",
  father: "profile.relation.father",
  mother: "profile.relation.mother",
  father_in_law: "profile.relation.fatherInLaw",
  mother_in_law: "profile.relation.motherInLaw",
  brother: "profile.relation.brother",
  sister: "profile.relation.sister",
  other: "profile.relation.other",
} as const;

/**
 * A relationship the schema stores as free text on `employee_contacts` and as a
 * CHECK'd set on `employee_dependents`. Unmapped values are humanised rather
 * than dropped — an unexpected value is still the employee's own data.
 */
export function relationshipLabel(value: string | null): string {
  if (value === null || value.trim() === "") return dash(null);
  const key = RELATIONSHIP_KEY[value as keyof typeof RELATIONSHIP_KEY];
  if (key !== undefined) return t(key);
  const words = value.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const NOMINEE_SCHEME_KEY = {
  pf: "profile.scheme.pf",
  gratuity: "profile.scheme.gratuity",
  esi: "profile.scheme.esi",
  group_insurance: "profile.scheme.groupInsurance",
} as const;

export function nomineeSchemeLabel(scheme: keyof typeof NOMINEE_SCHEME_KEY | null): string {
  return scheme === null ? dash(null) : t(NOMINEE_SCHEME_KEY[scheme]);
}

const SWIPE_CARD_STATUS_KEY = {
  requested: "profile.card.requested",
  approved: "profile.card.approved",
  active: "profile.card.active",
  lost: "profile.card.lost",
  damaged: "profile.card.damaged",
  returned: "profile.card.returned",
  revoked: "profile.card.revoked",
  reported_lost: "profile.card.reportedLost",
} as const;

export function swipeCardStatusLabel(status: keyof typeof SWIPE_CARD_STATUS_KEY): string {
  return t(SWIPE_CARD_STATUS_KEY[status]);
}

// -----------------------------------------------------------------------------
// Lifecycle events
// -----------------------------------------------------------------------------

const LIFECYCLE_EVENT_KEY = {
  offer_accepted: "profile.lifecycle.offerAccepted",
  joined: "profile.lifecycle.joined",
  probation_started: "profile.lifecycle.probationStarted",
  confirmed: "profile.lifecycle.confirmed",
  probation_extended: "profile.lifecycle.probationExtended",
  promoted: "profile.lifecycle.promoted",
  transferred: "profile.lifecycle.transferred",
  department_changed: "profile.lifecycle.departmentChanged",
  manager_changed: "profile.lifecycle.managerChanged",
  salary_revised: "profile.lifecycle.salaryRevised",
  suspended: "profile.lifecycle.suspended",
  reinstated: "profile.lifecycle.reinstated",
  notice_started: "profile.lifecycle.noticeStarted",
  resigned: "profile.lifecycle.resigned",
  terminated: "profile.lifecycle.terminated",
  absconded: "profile.lifecycle.absconded",
  retired: "profile.lifecycle.retired",
  contract_ended: "profile.lifecycle.contractEnded",
  rehired: "profile.lifecycle.rehired",
  deceased: "profile.lifecycle.deceased",
} as const;

export function lifecycleEventLabel(event: LifecycleEvent): string {
  return t(LIFECYCLE_EVENT_KEY[event.event_type]);
}

// -----------------------------------------------------------------------------
// jsonb From → To rendering
// -----------------------------------------------------------------------------

/**
 * Render a jsonb audit value for the From/To columns.
 *
 * "(not set)" is the DR-38 fix: the reference product left the prior value blank
 * and an employee could not tell "was empty" from "we did not record it". An
 * absent value is stated in words; the universal em dash stays reserved for
 * "no value to show at all".
 */
export function historyValueDisplay(value: unknown): string {
  if (value === null || value === undefined) return t("profile.history.notSet");
  if (typeof value === "string") {
    return value.trim() === "" ? t("profile.history.notSet") : value;
  }
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") {
    return value ? t("common.yes") : t("common.no");
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return t("profile.history.notSet");
    return value.map((v) => historyValueDisplay(v)).join(", ");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return t("profile.history.notSet");
    return entries
      .map(([k, v]) => `${humaniseKey(k)}: ${historyValueDisplay(v)}`)
      .join(" · ");
  }
  return t("profile.history.notSet");
}

/** `date_of_join` → `Date of join`. Only ever applied to jsonb payload keys. */
function humaniseKey(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// -----------------------------------------------------------------------------
// Custom-field values
// -----------------------------------------------------------------------------

/** A custom-field value rendered by its declared type — never a raw jsonb dump. */
export function customFieldDisplay(row: CustomFieldRow): string {
  const v = row.value;
  if (v === null) return dash(null);
  switch (row.def.field_type) {
    case "text":
    case "single_select":
      return dash(v.value_text);
    case "number":
      return v.value_number === null ? dash(null) : String(v.value_number);
    case "date":
      return fmtCivilDate(v.value_date);
    case "boolean":
      return v.value_boolean === null
        ? dash(null)
        : v.value_boolean
          ? t("common.yes")
          : t("common.no");
    case "multi_select":
      return Array.isArray(v.value_json)
        ? v.value_json.map((x) => String(x)).join(", ")
        : dash(null);
    case "employee_ref":
      // The referenced employee is resolved by the directory view when the
      // renderer needs a name; the raw id is never shown.
      return v.value_json === null ? dash(null) : t("profile.custom.employeeRef");
    case "file":
      return v.value_document_id === null ? dash(null) : t("profile.custom.fileAttached");
  }
}
