/**
 * /admin/time/attendance-policies — the rulebook every attendance number is
 * judged against (spec-admin §6.4).
 *
 * This is the screen the whole product leans on, so the form is written as
 * prose with numbers in it. `max_late_days_before_deduction = 3` is meaningless;
 * "the 4th late day in the window costs half a day of casual leave" is a policy
 * an HR manager can defend to an employee.
 *
 * Two structural notes:
 *  - `attendance_policies` has NO `sort_order`, so the identity group is built
 *    by hand rather than from the shared reference-table helper. Sending a
 *    column the table does not have is a PGRST204, and a screen that guesses at
 *    a schema is exactly what the contract forbids.
 *  - The table IS in `audit.reason_required_tables`, so every save prompts and
 *    the mutation carries no default reason.
  *
 * @route /admin/time/attendance-policies
 */
import { Cog } from "lucide-react";
import type { DataGridColumn } from "@/shared/ui/DataGrid";
import { fmtDurationHm } from "@/lib/datetime";
import { formatDays } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { AttendancePolicy, OrgListFilters } from "../api/org.api";
import { useDefaultCompanyId, useOrgList } from "../hooks/useMasters";
import { MasterBanner, MasterScreen } from "../components/MasterScreen";
import { DOW_OPTIONS, dowLabel, type FieldGroup } from "../masters/fields";
import { codeField, descriptionField, isActiveField, nameField } from "../masters/common";

function usePolicyRows(filters: OrgListFilters) {
  return useOrgList("attendancePolicies", filters);
}

const RESET_PERIODS = [
  { value: "calendar_month", label: t("admin.time.pol.resetPeriod.calendar_month") },
  { value: "pay_period", label: t("admin.time.pol.resetPeriod.pay_period") },
] as const;

const SINGLE_PUNCH = [
  { value: "absent", label: t("admin.time.pol.singlePunch.absent") },
  { value: "half_day", label: t("admin.time.pol.singlePunch.half_day") },
  { value: "present_flag_review", label: t("admin.time.pol.singlePunch.present_flag_review") },
  { value: "half_day_flag_review", label: t("admin.time.pol.singlePunch.half_day_flag_review") },
] as const;

const EXTRA_WORK = [
  { value: "comp_off", label: t("admin.time.pol.extra.comp_off") },
  { value: "paid", label: t("admin.time.pol.extra.paid") },
  { value: "both", label: t("admin.time.pol.extra.both") },
  { value: "none", label: t("admin.time.pol.extra.none") },
] as const;

const groups: FieldGroup[] = [
  {
    // attendance_policies carries no sort_order — hand-built on purpose.
    title: t("admin.master.group.identity"),
    fields: [codeField, nameField, descriptionField, isActiveField],
  },
  {
    title: t("admin.time.pol.group.lateness"),
    fields: [
      /*
        NOT required, since migration 039100. The engine reads
        `COALESCE(pol.grace_in_minutes, sh.grace_in_minutes, 10)`, and while these
        columns were NOT NULL DEFAULT 10 the shift branch was unreachable — every
        policy silently overrode every shift's grace, so per-shift grace did nothing
        for anybody with a policy. Left EMPTY, the shift now decides.
      */
      {
        name: "grace_in_minutes",
        label: t("admin.time.pol.field.graceIn"),
        kind: "number",
        help: t("admin.time.grace.policyOptional"),
        min: 0,
        max: 240,
      },
      {
        name: "grace_out_minutes",
        label: t("admin.time.pol.field.graceOut"),
        kind: "number",
        help: t("admin.time.grace.policyOptionalOut"),
        min: 0,
        max: 240,
      },
      {
        name: "late_after_grace_counts_full",
        label: t("admin.time.pol.field.lateCountsFull"),
        kind: "checkbox",
        help: t("admin.time.pol.help.lateCountsFull"),
      },
      {
        name: "max_late_days_before_deduction",
        label: t("admin.time.pol.field.maxLateDays"),
        kind: "number",
        help: t("admin.time.pol.help.maxLateDays"),
        min: 0,
        max: 31,
      },
      {
        name: "late_deduction_leave_days",
        label: t("admin.time.pol.field.lateDeductionDays"),
        kind: "decimal",
        help: t("admin.time.pol.help.lateDeductionDays"),
        min: 0,
        max: 5,
      },
      {
        name: "late_deduction_reset_period",
        label: t("admin.time.pol.field.lateResetPeriod"),
        kind: "select",
        help: t("admin.time.pol.help.lateResetPeriod"),
        required: true,
        options: RESET_PERIODS,
      },
      {
        name: "early_exit_deduction_enabled",
        label: t("admin.time.pol.field.earlyExitDeduction"),
        kind: "checkbox",
        help: t("admin.time.pol.help.earlyExitDeduction"),
      },
    ],
  },
  {
    title: t("admin.time.pol.group.classification"),
    fields: [
      {
        name: "half_day_minutes",
        label: t("admin.time.pol.field.halfDay"),
        kind: "number",
        help: t("admin.time.pol.help.halfDay"),
        min: 0,
        max: 1440,
      },
      {
        name: "absent_below_minutes",
        label: t("admin.time.pol.field.absentBelow"),
        kind: "number",
        help: t("admin.time.pol.help.absentBelow"),
        min: 0,
        max: 1440,
      },
      {
        name: "single_punch_treatment",
        label: t("admin.time.pol.field.singlePunch"),
        kind: "select",
        help: t("admin.time.pol.help.singlePunch"),
        required: true,
        options: SINGLE_PUNCH,
        wide: true,
      },
      {
        name: "missing_out_grace_minutes",
        label: t("admin.time.pol.field.missingOutGrace"),
        kind: "number",
        help: t("admin.time.pol.help.missingOutGrace"),
        min: 0,
        max: 480,
      },
      {
        name: "absent_marking_delay_hours",
        label: t("admin.time.pol.field.absentDelay"),
        kind: "number",
        help: t("admin.time.pol.help.absentDelay"),
        min: 0,
        max: 72,
      },
    ],
  },
  {
    title: t("admin.time.pol.group.breaks"),
    fields: [
      {
        name: "auto_deduct_break",
        label: t("admin.time.pol.field.autoDeductBreak"),
        kind: "checkbox",
        help: t("admin.time.pol.help.autoDeductBreak"),
      },
      {
        name: "min_break_minutes_to_count",
        label: t("admin.time.pol.field.minBreak"),
        kind: "number",
        help: t("admin.time.pol.help.minBreak"),
        min: 0,
        max: 240,
      },
      {
        name: "max_break_minutes_paid",
        label: t("admin.time.pol.field.maxPaidBreak"),
        kind: "number",
        help: t("admin.time.pol.help.maxPaidBreak"),
        min: 0,
        max: 240,
      },
    ],
  },
  {
    title: t("admin.time.pol.group.overtime"),
    fields: [
      {
        name: "overtime_enabled",
        label: t("admin.time.pol.field.otEnabled"),
        kind: "checkbox",
        help: t("admin.time.pol.help.otEnabled"),
      },
      {
        name: "overtime_requires_approval",
        label: t("admin.time.pol.field.otApproval"),
        kind: "checkbox",
        help: t("admin.time.pol.help.otApproval"),
      },
      {
        name: "overtime_multiplier",
        label: t("admin.time.pol.field.otMultiplier"),
        kind: "decimal",
        help: t("admin.time.pol.help.otMultiplier"),
        min: 1,
        max: 5,
      },
      {
        name: "overtime_min_minutes",
        label: t("admin.time.pol.field.otMin"),
        kind: "number",
        help: t("admin.time.pol.help.otMin"),
        min: 0,
        max: 480,
      },
      {
        name: "overtime_rounding_minutes",
        label: t("admin.time.pol.field.otRounding"),
        kind: "number",
        help: t("admin.time.pol.help.otRounding"),
        min: 1,
        max: 60,
      },
      {
        name: "max_overtime_minutes_per_day",
        label: t("admin.time.pol.field.otMaxDay"),
        kind: "number",
        help: t("admin.time.pol.help.otMaxDay"),
        min: 0,
        max: 1440,
      },
      {
        name: "max_overtime_minutes_per_week",
        label: t("admin.time.pol.field.otMaxWeek"),
        kind: "number",
        help: t("admin.time.pol.help.otMaxWeek"),
        min: 0,
        max: 6000,
      },
      {
        name: "max_payable_minutes_per_day",
        label: t("admin.time.pol.field.maxPayableDay"),
        kind: "number",
        help: t("admin.time.pol.help.maxPayableDay"),
        min: 0,
        max: 1440,
      },
    ],
  },
  {
    title: t("admin.time.pol.group.extra"),
    fields: [
      {
        name: "extra_work_compensation",
        label: t("admin.time.pol.field.extraWork"),
        kind: "select",
        help: t("admin.time.pol.help.extraWork"),
        required: true,
        options: EXTRA_WORK,
        wide: true,
      },
      {
        name: "comp_off_min_minutes",
        label: t("admin.time.pol.field.compOffMin"),
        kind: "number",
        help: t("admin.time.pol.help.compOffMin"),
        min: 0,
        max: 1440,
      },
      {
        name: "comp_off_full_day_minutes",
        label: t("admin.time.pol.field.compOffFull"),
        kind: "number",
        help: t("admin.time.pol.help.compOffFull"),
        min: 0,
        max: 1440,
      },
      {
        name: "comp_off_expiry_days",
        label: t("admin.time.pol.field.compOffExpiry"),
        kind: "number",
        help: t("admin.time.pol.help.compOffExpiry"),
        min: 1,
        max: 730,
      },
    ],
  },
  {
    title: t("admin.time.pol.group.regularisation"),
    fields: [
      {
        name: "regularization_window_days",
        label: t("admin.time.pol.field.regWindow"),
        kind: "number",
        help: t("admin.time.pol.help.regWindow"),
        min: 0,
        max: 90,
      },
      {
        name: "max_regularizations_per_month",
        label: t("admin.time.pol.field.regMax"),
        kind: "number",
        help: t("admin.time.pol.help.regMax"),
        min: 0,
        max: 31,
      },
      {
        name: "regularization_requires_manager",
        label: t("admin.time.pol.field.regManager"),
        kind: "checkbox",
        help: t("admin.time.pol.help.regManager"),
      },
    ],
  },
  {
    title: t("admin.time.pol.group.capture"),
    fields: [
      {
        name: "allow_web_punch",
        label: t("admin.time.pol.field.allowWeb"),
        kind: "checkbox",
        help: t("admin.time.pol.help.allowWeb"),
      },
      {
        name: "allow_mobile_punch",
        label: t("admin.time.pol.field.allowMobile"),
        kind: "checkbox",
        help: t("admin.time.pol.help.allowMobile"),
      },
      {
        name: "punch_debounce_seconds",
        label: t("admin.time.pol.field.debounce"),
        kind: "number",
        help: t("admin.time.pol.help.debounce"),
        min: 0,
        max: 3600,
      },
      {
        name: "require_liveness",
        label: t("admin.time.pol.field.requireLiveness"),
        kind: "checkbox",
        help: t("admin.time.pol.help.requireLiveness"),
      },
      {
        name: "min_confidence_for_auto_accept",
        label: t("admin.time.pol.field.minConfidence"),
        kind: "decimal",
        help: t("admin.time.pol.help.minConfidence"),
        min: 0,
        max: 1,
      },
      {
        name: "min_margin_for_auto_accept",
        label: t("admin.time.pol.field.minMargin"),
        kind: "decimal",
        help: t("admin.time.pol.help.minMargin"),
        min: 0,
        max: 1,
      },
    ],
  },
  {
    title: t("admin.time.pol.group.week"),
    fields: [
      {
        name: "week_start_dow",
        label: t("admin.time.pol.field.weekStart"),
        kind: "select",
        help: t("admin.time.pol.help.weekStart"),
        required: true,
        options: DOW_OPTIONS,
      },
    ],
  },
];

function lateRuleOf(row: AttendancePolicy): string {
  if (row.max_late_days_before_deduction === null || row.late_deduction_leave_days === null) {
    return t("admin.time.pol.lateRule.off");
  }
  const window =
    RESET_PERIODS.find((period) => period.value === row.late_deduction_reset_period)?.label ??
    t("admin.time.pol.resetPeriod.calendar_month");
  return t("admin.time.pol.lateRule", {
    days: row.max_late_days_before_deduction,
    leave: formatDays(row.late_deduction_leave_days),
    window,
  });
}

function otSummaryOf(row: AttendancePolicy): string {
  if (!row.overtime_enabled) return t("admin.time.pol.otOff");
  return t("admin.time.pol.otSummary", {
    mins: fmtDurationHm(row.overtime_min_minutes),
    mult: row.overtime_multiplier ?? 1,
  });
}

function channelsOf(row: AttendancePolicy): string {
  const channels = [t("admin.time.pol.channel.kiosk")];
  if (row.allow_web_punch) channels.push(t("admin.time.pol.channel.web"));
  if (row.allow_mobile_punch) channels.push(t("admin.time.pol.channel.mobile"));
  return channels.join(", ");
}

const columns: DataGridColumn<AttendancePolicy>[] = [
  {
    key: "grace_in_minutes",
    header: t("admin.time.pol.col.grace"),
    width: "7rem",
    align: "right",
    /* NULL is not zero grace — it means the shift decides. `fmtDurationHm(null)` would
       render 0:00 and read as "no grace at all", the opposite of the truth. */
    render: (row) =>
      row.grace_in_minutes === null
        ? t("admin.time.grace.fromShift")
        : fmtDurationHm(row.grace_in_minutes),
  },
  {
    key: "lateRule",
    header: t("admin.time.pol.col.lateRule"),
    hideBelow: "md",
    render: (row) => lateRuleOf(row),
  },
  {
    key: "classification",
    header: t("admin.time.pol.col.classification"),
    width: "11rem",
    align: "right",
    hideBelow: "lg",
    render: (row) =>
      row.half_day_minutes === null && row.absent_below_minutes === null
        ? t("admin.time.pol.fromShift")
        : `${fmtDurationHm(row.half_day_minutes)} / ${fmtDurationHm(row.absent_below_minutes)}`,
  },
  {
    key: "ot",
    header: t("admin.time.pol.col.ot"),
    width: "11rem",
    hideBelow: "md",
    render: (row) => otSummaryOf(row),
  },
  {
    key: "regularisation",
    header: t("admin.time.pol.col.regularisation"),
    hideBelow: "lg",
    render: (row) =>
      t("admin.time.pol.regSummary", {
        count: row.max_regularizations_per_month ?? 0,
        days: row.regularization_window_days ?? 0,
      }),
  },
  {
    key: "channels",
    header: t("admin.time.pol.col.channels"),
    hideBelow: "lg",
    render: (row) => channelsOf(row),
  },
];

export default function AttendancePoliciesPage() {
  const companyId = useDefaultCompanyId();

  return (
    <MasterScreen<AttendancePolicy>
      icon={Cog}
      title={t("admin.time.pol.title")}
      subtitle={t("admin.time.pol.subtitle")}
      entityLabel={t("admin.time.pol.entity")}
      entity="attendancePolicies"
      useRows={usePolicyRows}
      columns={columns}
      groups={groups}
      createDefaults={{
        is_active: "true",
        /* Empty, deliberately: a new policy that asserted a grace period would override
           every shift's, which is the bug migration 039100 fixed. */
        grace_in_minutes: "",
        grace_out_minutes: "",
        late_after_grace_counts_full: "true",
        max_late_days_before_deduction: "3",
        late_deduction_leave_days: "0.5",
        late_deduction_reset_period: "pay_period",
        early_exit_deduction_enabled: "false",
        auto_deduct_break: "true",
        min_break_minutes_to_count: "15",
        max_break_minutes_paid: "0",
        overtime_enabled: "true",
        overtime_requires_approval: "true",
        overtime_multiplier: "1.5",
        overtime_min_minutes: "30",
        overtime_rounding_minutes: "15",
        max_overtime_minutes_per_day: "240",
        max_overtime_minutes_per_week: "600",
        max_payable_minutes_per_day: "720",
        extra_work_compensation: "comp_off",
        comp_off_min_minutes: "240",
        comp_off_full_day_minutes: "480",
        comp_off_expiry_days: "90",
        single_punch_treatment: "half_day_flag_review",
        missing_out_grace_minutes: "0",
        absent_marking_delay_hours: "6",
        regularization_window_days: "15",
        max_regularizations_per_month: "3",
        regularization_requires_manager: "true",
        allow_web_punch: "false",
        allow_mobile_punch: "false",
        punch_debounce_seconds: "120",
        require_liveness: "true",
        min_confidence_for_auto_accept: "0.62",
        min_margin_for_auto_accept: "0.06",
        week_start_dow: "1",
      }}
      needsCompanyId
      companyId={companyId}
      retire="archive"
      promptOnSave
      banner={<MasterBanner>{t("admin.time.pol.banner")}</MasterBanner>}
      formBanner={<MasterBanner>{t("admin.time.pol.banner")}</MasterBanner>}
      helpVars={(values) => ({
        week_start_dow: t("admin.time.pol.help.weekStart", {
          day: dowLabel(Number.parseInt(values["week_start_dow"] ?? "", 10)),
        }),
      })}
    />
  );
}
