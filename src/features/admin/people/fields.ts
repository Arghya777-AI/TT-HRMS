/**
 * people/fields.ts — the declarative field model behind Add Employee and every
 * editable tab of Employee 360.
 *
 * It reuses the `FieldSpec` / `FieldGroup` vocabulary the twelve lookup-master
 * screens already use (`../masters/fields`), for three reasons that are not
 * cosmetic:
 *
 *  1. ONE coercion path. A `date` input yields 'YYYY-MM-DD', a checkbox yields a
 *     boolean, an empty box yields NULL rather than ''. `employees` has 30 NOT
 *     NULL columns with defaults; writing '' into one of them is the defect this
 *     avoids.
 *  2. ONE validation path, mirroring the CHECK constraints an admin can actually
 *     hit — the mobile regex `^[6-9][0-9]{9}$`, the two email regexes, the
 *     probation 0–24 and notice 0–180 ranges, `last_working_day >= date_of_join`
 *     and the sentinel-date ban. Those are `ck_employees__*` in migration 008;
 *     catching them in the browser spends the round trip on real work.
 *  3. ONE diff summary, so the reason dialog can state what is about to change
 *     with the old and new value (spec-admin §3.5).
 *
 * Every option list here is the DEPLOYED enum, in the migration's order —
 * `public.gender`, `public.blood_group`, `public.marital_status`,
 * `public.punch_mode`, `public.payment_mode`, `public.employment_type`,
 * `public.employment_status`, and the `ck_employees__exit_type` IN-list. No
 * value is invented, and no raw enum reaches the screen (D-10).
 *
 * Column membership is not free-form either: a field appears here only when it
 * is BOTH in an `EDITABLE_*_COLUMNS` set (admin has the column grant) AND in
 * `adminEmployeeSchema` (the view actually returns it). A field an admin could
 * write but not read back would render blank over a real value — a lie.
 *
 * Everything in this file is pure. No supabase, no React.
 */
import { fmtCivilDate } from "@/lib/datetime";
import { dash } from "@/lib/format";
import { t, type MessageKey } from "@/shared/i18n/en";
import {
  EMPLOYMENT_STATUS_LABELS,
  employmentStatusValues,
  employmentTypeValues,
  type EmploymentStatus,
  type EmploymentType,
} from "../api/employees.api";
import type {
  FieldGroup,
  FieldOption,
  FieldSpec,
  FormValues,
} from "../masters/fields";

// -----------------------------------------------------------------------------
// 1. Patterns that mirror the table's CHECK constraints (migration 008)
// -----------------------------------------------------------------------------

/** `ck_employees__mobile_in` — an Indian mobile, ten digits, first of 6–9. */
export const MOBILE_PATTERN = {
  re: /^[6-9]\d{9}$/,
  messageKey: "admin.people.err.mobile" as MessageKey,
};

/** `ck_employees__work_email` / `ck_employees__personal_email`. */
export const EMAIL_PATTERN = {
  re: /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i,
  messageKey: "admin.people.err.email" as MessageKey,
};

/** The sentinel-date ban (`ck_employees__sane_dates`) plus common sense. */
const EARLIEST_CIVIL_DATE = "1930-01-01";
const LATEST_CIVIL_DATE = "2099-12-31";

// -----------------------------------------------------------------------------
// 2. Enum option lists — the deployed values, humanised
// -----------------------------------------------------------------------------

export const EMPLOYMENT_STATUS_OPTIONS: readonly FieldOption[] = employmentStatusValues.map(
  (value: EmploymentStatus) => ({ value, label: EMPLOYMENT_STATUS_LABELS[value] }),
);

const EMPLOYMENT_TYPE_LABELS: Readonly<Record<EmploymentType, string>> = {
  permanent: t("admin.people.employmentType.permanent"),
  probation: t("admin.people.employmentType.probation"),
  contract: t("admin.people.employmentType.contract"),
  intern: t("admin.people.employmentType.intern"),
  consultant: t("admin.people.employmentType.consultant"),
  casual: t("admin.people.employmentType.casual"),
  apprentice: t("admin.people.employmentType.apprentice"),
  retainer: t("admin.people.employmentType.retainer"),
};

export const EMPLOYMENT_TYPE_OPTIONS: readonly FieldOption[] = employmentTypeValues.map(
  (value: EmploymentType) => ({ value, label: EMPLOYMENT_TYPE_LABELS[value] }),
);

/** `public.gender`. */
export const GENDER_OPTIONS: readonly FieldOption[] = [
  { value: "male", label: t("admin.people.gender.male") },
  { value: "female", label: t("admin.people.gender.female") },
  { value: "transgender", label: t("admin.people.gender.transgender") },
  { value: "prefer_not_to_say", label: t("admin.people.gender.prefer_not_to_say") },
];

/** `public.blood_group`. The notation is data; 'unknown' is the only word. */
export const BLOOD_GROUP_OPTIONS: readonly FieldOption[] = [
  { value: "A+", label: t("admin.people.bloodGroup.aPos") },
  { value: "A-", label: t("admin.people.bloodGroup.aNeg") },
  { value: "B+", label: t("admin.people.bloodGroup.bPos") },
  { value: "B-", label: t("admin.people.bloodGroup.bNeg") },
  { value: "AB+", label: t("admin.people.bloodGroup.abPos") },
  { value: "AB-", label: t("admin.people.bloodGroup.abNeg") },
  { value: "O+", label: t("admin.people.bloodGroup.oPos") },
  { value: "O-", label: t("admin.people.bloodGroup.oNeg") },
  { value: "unknown", label: t("admin.people.bloodGroup.unknown") },
];

/** `public.marital_status`. */
export const MARITAL_STATUS_OPTIONS: readonly FieldOption[] = [
  { value: "single", label: t("admin.people.marital.single") },
  { value: "married", label: t("admin.people.marital.married") },
  { value: "divorced", label: t("admin.people.marital.divorced") },
  { value: "widowed", label: t("admin.people.marital.widowed") },
  { value: "separated", label: t("admin.people.marital.separated") },
];

/** `public.punch_mode`. */
export const PUNCH_MODE_OPTIONS: readonly FieldOption[] = [
  { value: "multi_punch", label: t("admin.people.punchMode.multi_punch") },
  { value: "single_punch", label: t("admin.people.punchMode.single_punch") },
];

/** `public.payment_mode`. */
export const PAYMENT_MODE_OPTIONS: readonly FieldOption[] = [
  { value: "bank_transfer", label: t("admin.people.paymentMode.bank_transfer") },
  { value: "cash", label: t("admin.people.paymentMode.cash") },
  { value: "cheque", label: t("admin.people.paymentMode.cheque") },
  { value: "upi", label: t("admin.people.paymentMode.upi") },
];

/** `ck_employees__exit_type` — a text column with an IN-list, not an enum. */
export const EXIT_TYPE_OPTIONS: readonly FieldOption[] = [
  { value: "resignation", label: t("admin.people.exitType.resignation") },
  { value: "termination", label: t("admin.people.exitType.termination") },
  { value: "end_of_contract", label: t("admin.people.exitType.end_of_contract") },
  { value: "retirement", label: t("admin.people.exitType.retirement") },
  { value: "absconding", label: t("admin.people.exitType.absconding") },
  { value: "death", label: t("admin.people.exitType.death") },
];

// -----------------------------------------------------------------------------
// 3. Reference lists the pickers need — resolved by the page, passed in here
// -----------------------------------------------------------------------------

export interface PeopleRefs {
  readonly departments: readonly FieldOption[];
  readonly sections: readonly FieldOption[];
  readonly designations: readonly FieldOption[];
  readonly grades: readonly FieldOption[];
  readonly locations: readonly FieldOption[];
  readonly costCentres: readonly FieldOption[];
  readonly shifts: readonly FieldOption[];
  readonly weeklyOffRules: readonly FieldOption[];
  readonly holidayCalendars: readonly FieldOption[];
  readonly attendancePolicies: readonly FieldOption[];
  readonly payPeriods: readonly FieldOption[];
  /** Every employee, for the reporting and dotted lines. */
  readonly managers: readonly FieldOption[];
  /** This employee's own bank accounts — 360 Payment tab only. */
  readonly bankAccounts: readonly FieldOption[];
}

export const EMPTY_PEOPLE_REFS: PeopleRefs = {
  departments: [],
  sections: [],
  designations: [],
  grades: [],
  locations: [],
  costCentres: [],
  shifts: [],
  weeklyOffRules: [],
  holidayCalendars: [],
  attendancePolicies: [],
  payPeriods: [],
  managers: [],
  bankAccounts: [],
};

// -----------------------------------------------------------------------------
// 4. The groups
// -----------------------------------------------------------------------------

/** Name and contact — `EDITABLE_PERSONAL_COLUMNS`, the subset the view returns. */
export function nameGroup(): FieldGroup {
  return {
    title: t("admin.people.group.name"),
    fields: [
      { name: "title", label: t("admin.people.field.title"), kind: "text", maxLength: 20 },
      {
        name: "first_name",
        label: t("admin.people.field.firstName"),
        kind: "text",
        required: true,
        maxLength: 80,
      },
      { name: "middle_name", label: t("admin.people.field.middleName"), kind: "text", maxLength: 80 },
      {
        name: "last_name",
        label: t("admin.people.field.lastName"),
        kind: "text",
        required: true,
        maxLength: 80,
      },
      {
        name: "display_name",
        label: t("admin.people.field.displayName"),
        kind: "text",
        required: true,
        help: t("admin.people.help.displayName"),
        maxLength: 160,
        wide: true,
      },
      {
        name: "preferred_name",
        label: t("admin.people.field.preferredName"),
        kind: "text",
        help: t("admin.people.help.preferredName"),
        maxLength: 80,
      },
      {
        name: "name_in_local_script",
        label: t("admin.people.field.localName"),
        kind: "text",
        help: t("admin.people.help.localName"),
        maxLength: 160,
      },
    ],
  };
}

export function contactGroup(): FieldGroup {
  return {
    title: t("admin.people.group.contact"),
    fields: [
      {
        name: "mobile",
        label: t("admin.people.field.mobile"),
        kind: "text",
        help: t("admin.people.help.mobile"),
        pattern: MOBILE_PATTERN,
        maxLength: 10,
      },
      {
        name: "work_email",
        label: t("admin.people.field.workEmail"),
        kind: "text",
        help: t("admin.people.help.workEmail"),
        pattern: EMAIL_PATTERN,
        maxLength: 160,
      },
      {
        name: "personal_email",
        label: t("admin.people.field.personalEmail"),
        kind: "text",
        help: t("admin.people.help.personalEmail"),
        pattern: EMAIL_PATTERN,
        maxLength: 160,
      },
    ],
  };
}

/** The Basic tab of the 360, and step 1 of the wizard. */
export function basicGroups(): readonly FieldGroup[] {
  return [nameGroup(), contactGroup()];
}

/** Terms of employment — `EDITABLE_EMPLOYMENT_COLUMNS`, the dates and the type. */
export function employmentTermsGroup(): FieldGroup {
  return {
    title: t("admin.people.group.terms"),
    fields: [
      {
        name: "employment_type",
        label: t("admin.people.field.employmentType"),
        kind: "select",
        required: true,
        help: t("admin.people.help.employmentType"),
        options: EMPLOYMENT_TYPE_OPTIONS,
      },
      {
        name: "employment_status",
        label: t("admin.people.field.employmentStatus"),
        kind: "select",
        required: true,
        help: t("admin.people.help.employmentStatus"),
        options: EMPLOYMENT_STATUS_OPTIONS,
      },
      {
        name: "date_of_join",
        label: t("admin.people.field.dateOfJoin"),
        kind: "date",
        required: true,
        help: t("admin.people.help.dateOfJoin"),
      },
      {
        name: "probation_months",
        label: t("admin.people.field.probationMonths"),
        kind: "number",
        required: true,
        help: t("admin.people.help.probationMonths"),
        min: 0,
        max: 24,
      },
      {
        name: "confirmed_on",
        label: t("admin.people.field.confirmedOn"),
        kind: "date",
        help: t("admin.people.help.confirmedOn"),
      },
      {
        name: "notice_period_days",
        label: t("admin.people.field.noticeDays"),
        kind: "number",
        required: true,
        help: t("admin.people.help.noticeDays"),
        min: 0,
        max: 180,
      },
      {
        name: "contract_start_date",
        label: t("admin.people.field.contractStart"),
        kind: "date",
        help: t("admin.people.help.contractStart"),
      },
      {
        name: "contract_end_date",
        label: t("admin.people.field.contractEnd"),
        kind: "date",
        help: t("admin.people.help.contractEnd"),
      },
      {
        name: "work_order_number",
        label: t("admin.people.field.workOrder"),
        kind: "text",
        help: t("admin.people.help.workOrder"),
        maxLength: 60,
      },
    ],
  };
}

/** Where the person sits — the six lookups plus the two reporting lines. */
export function orgPlacementGroup(refs: PeopleRefs, excludeSelf?: string): FieldGroup {
  const managers = excludeSelf === undefined
    ? refs.managers
    : refs.managers.filter((option) => option.value !== excludeSelf);
  return {
    title: t("admin.people.group.placement"),
    fields: [
      {
        name: "department_id",
        label: t("admin.people.field.department"),
        kind: "select",
        help: t("admin.people.help.department"),
        options: refs.departments,
      },
      {
        name: "section_id",
        label: t("admin.people.field.section"),
        kind: "select",
        help: t("admin.people.help.section"),
        options: refs.sections,
      },
      {
        name: "designation_id",
        label: t("admin.people.field.designation"),
        kind: "select",
        help: t("admin.people.help.designation"),
        options: refs.designations,
      },
      {
        name: "grade_id",
        label: t("admin.people.field.grade"),
        kind: "select",
        help: t("admin.people.help.grade"),
        options: refs.grades,
      },
      {
        name: "location_id",
        label: t("admin.people.field.location"),
        kind: "select",
        help: t("admin.people.help.location"),
        options: refs.locations,
      },
      {
        name: "cost_centre_id",
        label: t("admin.people.field.costCentre"),
        kind: "select",
        help: t("admin.people.help.costCentre"),
        options: refs.costCentres,
      },
      {
        name: "reporting_manager_id",
        label: t("admin.people.field.manager"),
        kind: "select",
        help: t("admin.people.help.manager"),
        options: managers,
      },
      {
        name: "dotted_line_manager_id",
        label: t("admin.people.field.dottedManager"),
        kind: "select",
        help: t("admin.people.help.dottedManager"),
        options: managers,
      },
    ],
  };
}

/** The Employment tab of the 360 — terms and placement save as one patch. */
export function employmentGroups(refs: PeopleRefs, excludeSelf?: string): readonly FieldGroup[] {
  return [employmentTermsGroup(), orgPlacementGroup(refs, excludeSelf)];
}

/** Attendance & payroll wiring — `EDITABLE_TIME_POLICY_COLUMNS`. */
export function timePolicyGroups(refs: PeopleRefs): readonly FieldGroup[] {
  return [
    {
      title: t("admin.people.group.timeRules"),
      fields: [
        {
          name: "shift_id",
          label: t("admin.people.field.shift"),
          kind: "select",
          help: t("admin.people.help.shift"),
          options: refs.shifts,
        },
        {
          name: "weekly_off_rule_id",
          label: t("admin.people.field.weeklyOff"),
          kind: "select",
          help: t("admin.people.help.weeklyOff"),
          options: refs.weeklyOffRules,
        },
        {
          name: "holiday_calendar_id",
          label: t("admin.people.field.holidayCalendar"),
          kind: "select",
          help: t("admin.people.help.holidayCalendar"),
          options: refs.holidayCalendars,
        },
        {
          name: "attendance_policy_id",
          label: t("admin.people.field.attendancePolicy"),
          kind: "select",
          help: t("admin.people.help.attendancePolicy"),
          options: refs.attendancePolicies,
        },
        {
          name: "pay_period_id",
          label: t("admin.people.field.payPeriod"),
          kind: "select",
          help: t("admin.people.help.payPeriod"),
          options: refs.payPeriods,
        },
        {
          name: "punch_mode",
          label: t("admin.people.field.punchMode"),
          kind: "select",
          required: true,
          help: t("admin.people.help.punchMode"),
          options: PUNCH_MODE_OPTIONS,
        },
        {
          name: "attendance_regularize_from",
          label: t("admin.people.field.regulariseFrom"),
          kind: "date",
          help: t("admin.people.help.regulariseFrom"),
        },
      ],
    },
    {
      title: t("admin.people.group.timeFlags"),
      fields: [
        {
          name: "is_shift_worker",
          label: t("admin.people.field.isShiftWorker"),
          kind: "checkbox",
          help: t("admin.people.help.isShiftWorker"),
        },
        {
          name: "is_ot_eligible",
          label: t("admin.people.field.isOtEligible"),
          kind: "checkbox",
          help: t("admin.people.help.isOtEligible"),
        },
        {
          name: "allow_web_punch",
          label: t("admin.people.field.allowWebPunch"),
          kind: "checkbox",
          help: t("admin.people.help.allowWebPunch"),
        },
        {
          name: "allow_mobile_selfie_punch",
          label: t("admin.people.field.allowSelfiePunch"),
          kind: "checkbox",
          help: t("admin.people.help.allowSelfiePunch"),
        },
        {
          name: "restrict_punch_to_venue_ip",
          label: t("admin.people.field.restrictToVenueIp"),
          kind: "checkbox",
          help: t("admin.people.help.restrictToVenueIp"),
        },
        {
          name: "exclude_from_attendance",
          label: t("admin.people.field.excludeFromAttendance"),
          kind: "checkbox",
          help: t("admin.people.help.excludeFromAttendance"),
        },
      ],
    },
  ];
}

/**
 * The Payment tab's WRITABLE half. PAN, Aadhaar, UAN, PF, ESI and the account
 * number are NOT on `employees` — they live on `employee_statutory` and
 * `employee_bank_accounts`, which no client role may write. The tab renders them
 * masked, read-only, with a reveal; this group is the part an admin owns.
 */
export function paymentGroups(refs: PeopleRefs): readonly FieldGroup[] {
  return [
    {
      title: t("admin.people.group.payment"),
      hint: t("admin.people.group.paymentHint"),
      fields: [
        {
          name: "payment_mode",
          label: t("admin.people.field.paymentMode"),
          kind: "select",
          required: true,
          help: t("admin.people.help.paymentMode"),
          options: PAYMENT_MODE_OPTIONS,
        },
        {
          name: "primary_bank_account_id",
          label: t("admin.people.field.primaryAccount"),
          kind: "select",
          help: t("admin.people.help.primaryAccount"),
          options: refs.bankAccounts,
        },
        {
          name: "exclude_from_payroll",
          label: t("admin.people.field.excludeFromPayroll"),
          kind: "checkbox",
          help: t("admin.people.help.excludeFromPayroll"),
        },
      ],
    },
  ];
}

/** The Personal tab — the subset of `EDITABLE_PERSONAL_COLUMNS` the view returns. */
export function personalGroups(): readonly FieldGroup[] {
  return [
    {
      title: t("admin.people.group.personal"),
      fields: [
        {
          name: "date_of_birth",
          label: t("admin.people.field.dateOfBirth"),
          kind: "date",
          help: t("admin.people.help.dateOfBirth"),
        },
        {
          name: "gender",
          label: t("admin.people.field.gender"),
          kind: "select",
          options: GENDER_OPTIONS,
        },
        {
          name: "blood_group",
          label: t("admin.people.field.bloodGroup"),
          kind: "select",
          required: true,
          help: t("admin.people.help.bloodGroup"),
          options: BLOOD_GROUP_OPTIONS,
        },
        {
          name: "marital_status",
          label: t("admin.people.field.maritalStatus"),
          kind: "select",
          options: MARITAL_STATUS_OPTIONS,
        },
        {
          name: "nationality",
          label: t("admin.people.field.nationality"),
          kind: "text",
          required: true,
          maxLength: 60,
        },
        {
          name: "father_or_spouse_name",
          label: t("admin.people.field.fatherOrSpouse"),
          kind: "text",
          help: t("admin.people.help.fatherOrSpouse"),
          maxLength: 160,
        },
        {
          name: "mother_name",
          label: t("admin.people.field.motherName"),
          kind: "text",
          maxLength: 160,
        },
        {
          name: "about",
          label: t("admin.people.field.about"),
          kind: "textarea",
          help: t("admin.people.help.about"),
          maxLength: 1000,
        },
      ],
    },
  ];
}

/** The Exit tab — every field here is in `REASON_PROMPTING_COLUMNS` bar two. */
export function exitGroups(): readonly FieldGroup[] {
  return [
    {
      title: t("admin.people.group.exit"),
      hint: t("admin.people.group.exitHint"),
      fields: [
        {
          name: "resignation_date",
          label: t("admin.people.field.resignationDate"),
          kind: "date",
          help: t("admin.people.help.resignationDate"),
        },
        {
          name: "last_working_day",
          label: t("admin.people.field.lastWorkingDay"),
          kind: "date",
          help: t("admin.people.help.lastWorkingDay"),
        },
        {
          name: "exit_type",
          label: t("admin.people.field.exitType"),
          kind: "select",
          help: t("admin.people.help.exitType"),
          options: EXIT_TYPE_OPTIONS,
        },
        {
          name: "exit_reason",
          label: t("admin.people.field.exitReason"),
          kind: "textarea",
          help: t("admin.people.help.exitReason"),
          maxLength: 1000,
        },
        {
          name: "is_rehire_eligible",
          label: t("admin.people.field.rehireEligible"),
          kind: "checkbox",
          help: t("admin.people.help.rehireEligible"),
        },
        {
          name: "full_and_final_settled_on",
          label: t("admin.people.field.fnfSettled"),
          kind: "date",
          help: t("admin.people.help.fnfSettled"),
        },
      ],
    },
  ];
}

// -----------------------------------------------------------------------------
// 5. Add Employee — the wizard's four collecting steps
// -----------------------------------------------------------------------------

export type WizardStepId = "identity" | "employment" | "placement" | "policy" | "review";

export const WIZARD_STEPS: readonly WizardStepId[] = [
  "identity",
  "employment",
  "placement",
  "policy",
  "review",
];

export function wizardStepTitle(step: WizardStepId): string {
  switch (step) {
    case "identity":
      return t("admin.people.add.step.identity");
    case "employment":
      return t("admin.people.add.step.employment");
    case "placement":
      return t("admin.people.add.step.placement");
    case "policy":
      return t("admin.people.add.step.policy");
    case "review":
      return t("admin.people.add.step.review");
  }
}

export function wizardStepHint(step: WizardStepId): string {
  switch (step) {
    case "identity":
      return t("admin.people.add.hint.identity");
    case "employment":
      return t("admin.people.add.hint.employment");
    case "placement":
      return t("admin.people.add.hint.placement");
    case "policy":
      return t("admin.people.add.hint.policy");
    case "review":
      return t("admin.people.add.hint.review");
  }
}

/** The field model for one wizard step. `review` collects nothing. */
export function wizardStepGroups(step: WizardStepId, refs: PeopleRefs): readonly FieldGroup[] {
  switch (step) {
    case "identity":
      return [nameGroup(), contactGroup(), ...personalGroups()];
    case "employment":
      return [employmentTermsGroup()];
    case "placement":
      return [orgPlacementGroup(refs)];
    case "policy":
      return timePolicyGroups(refs);
    case "review":
      return [];
  }
}

/** Every group the wizard collects, in order — the Review step reads them all. */
export function allWizardGroups(refs: PeopleRefs): readonly FieldGroup[] {
  return WIZARD_STEPS.flatMap((step) => wizardStepGroups(step, refs));
}

/**
 * Seed values for a new employee, matching the table's own DEFAULTs (migration
 * 008) so the form shows what the database would do anyway rather than a blank
 * that turns into a NULL on a NOT NULL column.
 */
export const NEW_EMPLOYEE_DEFAULTS: Readonly<Record<string, string>> = {
  employment_type: "probation",
  employment_status: "pre_joining",
  probation_months: "6",
  notice_period_days: "30",
  blood_group: "unknown",
  nationality: "Indian",
  punch_mode: "multi_punch",
  payment_mode: "bank_transfer",
  is_ot_eligible: "true",
  is_shift_worker: "true",
  allow_web_punch: "false",
  allow_mobile_selfie_punch: "false",
  restrict_punch_to_venue_ip: "true",
  exclude_from_attendance: "false",
  exclude_from_payroll: "false",
};

/**
 * `display_name` is NOT NULL and is the only name the product ever renders, so
 * the wizard fills it from the parts rather than making the admin type the name
 * twice. Returns the values unchanged when it is already set.
 */
export function withDerivedDisplayName(values: FormValues): Record<string, string> {
  const next = { ...values };
  if ((next["display_name"] ?? "").trim() !== "") return next;
  const parts = [next["first_name"], next["middle_name"], next["last_name"]]
    .map((part) => (part ?? "").trim())
    .filter((part) => part !== "");
  if (parts.length > 0) next["display_name"] = parts.join(" ");
  return next;
}

// -----------------------------------------------------------------------------
// 6. Cross-field validation — the CHECK constraints an admin can actually hit
// -----------------------------------------------------------------------------

function civilDate(values: FormValues, name: string): string | null {
  const raw = (values[name] ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

/**
 * One sentence naming the first cross-field problem, or null. Deliberately
 * ordered: the sanity of `date_of_join` comes first, because every other date
 * on the record is read relative to it.
 *
 * `today` is passed in (never read from `new Date()` here) so this stays pure
 * and the IST business date is the caller's single source.
 */
export function employeeFormError(values: FormValues, todayIst: string): string | null {
  const doj = civilDate(values, "date_of_join");
  if ((values["date_of_join"] ?? "").trim() !== "" && doj === null) {
    return t("admin.people.err.dateShape");
  }
  if (doj !== null) {
    if (doj < EARLIEST_CIVIL_DATE || doj > LATEST_CIVIL_DATE) {
      return t("admin.people.err.dojAbsurd", {
        earliest: fmtCivilDate(EARLIEST_CIVIL_DATE),
        latest: fmtCivilDate(LATEST_CIVIL_DATE),
      });
    }
  }
  const dob = civilDate(values, "date_of_birth");
  if (dob !== null && doj !== null && dob >= doj) {
    return t("admin.people.err.dobAfterDoj");
  }
  const contractStart = civilDate(values, "contract_start_date");
  const contractEnd = civilDate(values, "contract_end_date");
  if (contractStart !== null && contractEnd !== null && contractEnd < contractStart) {
    return t("admin.people.err.contractOrder");
  }
  const lwd = civilDate(values, "last_working_day");
  if (lwd !== null && doj !== null && lwd < doj) {
    return t("admin.people.err.lwdBeforeDoj");
  }
  const resignation = civilDate(values, "resignation_date");
  if (resignation !== null && lwd !== null && lwd < resignation) {
    return t("admin.people.err.lwdBeforeResignation");
  }
  if ((values["employment_status"] ?? "") === "exited" && (lwd === null || (values["exit_type"] ?? "").trim() === "")) {
    return t("admin.people.err.exitIncomplete");
  }
  const confirmedOn = civilDate(values, "confirmed_on");
  if (confirmedOn !== null && doj !== null && confirmedOn < doj) {
    return t("admin.people.err.confirmedBeforeDoj");
  }
  if (doj !== null && doj > todayIst && (values["employment_status"] ?? "") !== "pre_joining") {
    return t("admin.people.err.futureJoinNotPreJoining");
  }
  return null;
}

// -----------------------------------------------------------------------------
// 7. Read-only rendering of a field value
// -----------------------------------------------------------------------------

/**
 * What a field's stored value looks like on a read-only row. Dates go through
 * `fmtCivilDate` (one date format app-wide), a select shows its option LABEL and
 * never the id or the enum, and an absent value is `—` — never blank, never 0.
 */
export function displayFieldValue(field: FieldSpec, raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (field.kind === "checkbox") {
    if (value === "") return dash(null);
    return value === "true" ? t("admin.master.yes") : t("admin.master.no");
  }
  if (value === "") return dash(null);
  switch (field.kind) {
    case "select":
      return field.options?.find((option) => option.value === value)?.label ?? dash(null);
    case "date":
      return fmtCivilDate(value);
    default:
      return value;
  }
}

/** True when a field's value should render in the tabular-numerals style. */
export function isNumericField(field: FieldSpec): boolean {
  return (
    field.kind === "number" ||
    field.kind === "decimal" ||
    field.kind === "date" ||
    field.kind === "rupees"
  );
}
