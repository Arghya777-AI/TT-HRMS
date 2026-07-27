/**
 * leave-config-vocab.ts — how the leave configuration screens SPEAK.
 *
 * Three jobs, none of which belongs in a component:
 *
 *  1. Enum → sentence. `carry_forward_out`, `pro_rata_accrual` and
 *     `comp_off_expiry` never reach a screen (D-10, DR-53). `LEDGER_ENTRY_CHIP`
 *     is exhaustive over `public.ledger_entry_type` (16 values, migration 003),
 *     so adding a value to the enum without a label is a COMPILE error rather
 *     than a raw string leaking into a statement.
 *  2. Tone with the sign. A debit is never rendered in a calm colour: on a leave
 *     statement `lapse` and `late_deduction` are losses and read as such
 *     (DR-45), while `accrual` and `carry_forward_in` are credits.
 *  3. Rulebook → English. `leave_types` stores carry-forward and encashment as
 *     four nullable numbers and two flags; an administrator needs the sentence
 *     those six columns add up to, in this venue's own numbers, BEFORE they touch
 *     them. `rolloverRule()` and `encashmentRule()` are that sentence, and they
 *     are pure so the type master, the rollover review and the encashment screen
 *     cannot describe the same rule two different ways.
 *
 * Everything here is pure: no supabase, no React, no arithmetic on a balance.
 */
import type { StatusChipEntry } from "@/shared/ui/StatusChip";
import { formatDays } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { LeaveType } from "./api/leave.api";
import type { LedgerEntryType, RolloverRun } from "./api/leave-config.api";

// -----------------------------------------------------------------------------
// 1. Ledger movements
// -----------------------------------------------------------------------------

/** `public.ledger_entry_type` → label + tone. Exhaustive by construction. */
export const LEDGER_ENTRY_CHIP: Readonly<Record<LedgerEntryType, StatusChipEntry>> = {
  opening_balance: { label: t("adminLeave.entry.opening_balance"), tone: "neutral" },
  accrual: { label: t("adminLeave.entry.accrual"), tone: "success" },
  pro_rata_accrual: { label: t("adminLeave.entry.pro_rata_accrual"), tone: "success" },
  credit_adjustment: { label: t("adminLeave.entry.credit_adjustment"), tone: "info" },
  carry_forward_in: { label: t("adminLeave.entry.carry_forward_in"), tone: "success" },
  carry_forward_out: { label: t("adminLeave.entry.carry_forward_out"), tone: "warn" },
  encashment: { label: t("adminLeave.entry.encashment"), tone: "info" },
  lapse: { label: t("adminLeave.entry.lapse"), tone: "danger" },
  availed: { label: t("adminLeave.entry.availed"), tone: "warn" },
  availed_reversal: { label: t("adminLeave.entry.availed_reversal"), tone: "success" },
  debit_adjustment: { label: t("adminLeave.entry.debit_adjustment"), tone: "warn" },
  late_deduction: { label: t("adminLeave.entry.late_deduction"), tone: "danger" },
  comp_off_credit: { label: t("adminLeave.entry.comp_off_credit"), tone: "success" },
  comp_off_debit: { label: t("adminLeave.entry.comp_off_debit"), tone: "warn" },
  comp_off_expiry: { label: t("adminLeave.entry.comp_off_expiry"), tone: "danger" },
  settlement: { label: t("adminLeave.entry.settlement"), tone: "info" },
};

/**
 * The kind filter on a statement, as SERVER predicates.
 *
 * Grouped rather than sixteen options because that is how the question is asked
 * ("show me only what was taken", "only the year-end movements"), and each group
 * is an `entry_type IN (…)` the count and the grid both apply — never a filter
 * applied to rows already on screen.
 */
export interface LedgerKindGroup {
  readonly value: string;
  readonly label: string;
  readonly types: readonly LedgerEntryType[];
}

export const LEDGER_KIND_GROUPS: readonly LedgerKindGroup[] = [
  {
    value: "credits",
    label: t("adminLeave.ledger.kind.credits"),
    types: [
      "opening_balance",
      "accrual",
      "pro_rata_accrual",
      "credit_adjustment",
      "carry_forward_in",
      "comp_off_credit",
      "availed_reversal",
    ],
  },
  {
    value: "debits",
    label: t("adminLeave.ledger.kind.debits"),
    types: [
      "availed",
      "debit_adjustment",
      "late_deduction",
      "comp_off_debit",
      "comp_off_expiry",
      "carry_forward_out",
      "encashment",
      "lapse",
      "settlement",
    ],
  },
  { value: "availed", label: t("adminLeave.ledger.kind.availed"), types: ["availed", "availed_reversal"] },
  {
    value: "adjustments",
    label: t("adminLeave.ledger.kind.adjustments"),
    types: ["credit_adjustment", "debit_adjustment"],
  },
  {
    value: "yearEnd",
    label: t("adminLeave.ledger.kind.yearEnd"),
    types: ["carry_forward_in", "carry_forward_out", "lapse", "encashment"],
  },
];

/** The group a filter value names, or null for "every movement". */
export function ledgerKindGroup(value: string): LedgerKindGroup | null {
  return LEDGER_KIND_GROUPS.find((group) => group.value === value) ?? null;
}

/**
 * Where a movement came from, in words — `leave_ledger` records the origin as a
 * set of nullable foreign keys (§7.2 `origin`), and the reader needs the noun.
 */
export function ledgerOrigin(row: {
  leave_request_id: string | null;
  attendance_day_id: string | null;
  comp_off_ledger_id: string | null;
  payroll_run_id: string | null;
  entry_type: LedgerEntryType;
}): string {
  if (row.leave_request_id !== null) return t("adminLeave.ledger.origin.request");
  if (row.comp_off_ledger_id !== null) return t("adminLeave.ledger.origin.compOff");
  if (row.attendance_day_id !== null) return t("adminLeave.ledger.origin.attendance");
  if (row.payroll_run_id !== null) return t("adminLeave.ledger.origin.payroll");
  if (row.entry_type === "accrual" || row.entry_type === "pro_rata_accrual")
    return t("adminLeave.ledger.origin.accrualJob");
  if (row.entry_type === "opening_balance") return t("adminLeave.ledger.origin.opening");
  return t("adminLeave.ledger.origin.system");
}

// -----------------------------------------------------------------------------
// 2. The rulebook, as sentences
// -----------------------------------------------------------------------------

/**
 * What happens to this type's balance at year end, in this venue's numbers.
 *
 * Reads `carry_forward_allowed`, `max_carry_forward_days` and
 * `carry_forward_expiry_months` — the three columns the rollover job (when it
 * ships) will read. It states the rule; it never applies it to a balance.
 */
export function rolloverRule(type: LeaveType): string {
  if (type.is_comp_off) return t("adminLeave.rule.cf.compOff");
  if (!type.carry_forward_allowed) return t("adminLeave.rule.cf.none");
  if (type.max_carry_forward_days === null) return t("adminLeave.rule.cf.uncapped");
  const capped = t("adminLeave.rule.cf.capped", {
    cap: formatDays(type.max_carry_forward_days),
  });
  if (type.carry_forward_expiry_months === null) return capped;
  return `${capped} ${t("adminLeave.rule.cf.expiry", { months: type.carry_forward_expiry_months })}`;
}

/** Whether and how far this type may be encashed. */
export function encashmentRule(type: LeaveType): string {
  if (!type.encashment_allowed) return t("adminLeave.rule.encash.no");
  if (type.max_encashment_days === null) return t("adminLeave.rule.encash.uncapped");
  return t("adminLeave.rule.encash.capped", { cap: formatDays(type.max_encashment_days) });
}

/** How the type is credited: the accrual rule as one line (spec-admin §7.1). */
export function accrualRule(type: LeaveType): string {
  if (type.is_comp_off) return t("adminLeave.rule.accrual.compOff");
  if (type.accrual_on_working_days_basis && type.accrual_days_per_worked_days !== null)
    return t("adminLeave.rule.accrual.perWorked", {
      days: formatDays(type.accrual_days_per_worked_days),
    });
  switch (type.accrual_frequency) {
    case "none":
      return type.annual_quota_days === null
        ? t("adminLeave.rule.accrual.manual")
        : t("adminLeave.rule.accrual.upfront", { days: formatDays(type.annual_quota_days) });
    case "monthly":
    case "quarterly":
    case "half_yearly":
    case "annual":
      return t("adminLeave.rule.accrual.periodic", {
        days: formatDays(type.accrual_days_per_period),
        period: accrualFrequencyLabel(type.accrual_frequency),
      });
    case "per_worked_days":
      return t("adminLeave.rule.accrual.perWorkedUnset");
    case "on_confirmation":
      return t("adminLeave.rule.accrual.onConfirmation");
    default:
      return t("adminLeave.rule.accrual.manual");
  }
}

/** `public.accrual_frequency` → label. Unknown values humanise, never leak. */
export function accrualFrequencyLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = {
    none: t("adminLeave.freq.none"),
    monthly: t("adminLeave.freq.monthly"),
    quarterly: t("adminLeave.freq.quarterly"),
    half_yearly: t("adminLeave.freq.half_yearly"),
    annual: t("adminLeave.freq.annual"),
    per_worked_days: t("adminLeave.freq.per_worked_days"),
    on_confirmation: t("adminLeave.freq.on_confirmation"),
  };
  return labels[value] ?? t("adminLeave.freq.none");
}

/** `leave_types.unit` → label (`ck_lt__unit` allows exactly these three). */
export function leaveUnitLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = {
    day: t("adminLeave.unit.day"),
    half_day: t("adminLeave.unit.half_day"),
    hour: t("adminLeave.unit.hour"),
  };
  return labels[value] ?? value;
}

// -----------------------------------------------------------------------------
// 3. Leave years and rollover runs
// -----------------------------------------------------------------------------

/**
 * The financial-year label for a leave year. `public.leave_year_of` returns the
 * FY START year on an April basis (2026 = FY 2026-27), so a bare "2026" above a
 * balance would be read as the calendar year by everybody in the room.
 */
export function leaveYearLabel(year: number): string {
  return t("adminLeave.year.label", { from: year, to: String(year + 1).slice(-2) });
}

/** `public.job_run_status` → label + tone, exhaustive over the deployed enum. */
export const ROLLOVER_STATUS_CHIP: Readonly<Record<RolloverRun["status"], StatusChipEntry>> = {
  running: { label: t("adminLeave.runStatus.running"), tone: "info" },
  succeeded: { label: t("adminLeave.runStatus.succeeded"), tone: "success" },
  failed: { label: t("adminLeave.runStatus.failed"), tone: "danger" },
  skipped: { label: t("adminLeave.runStatus.skipped"), tone: "neutral" },
  timed_out: { label: t("adminLeave.runStatus.timed_out"), tone: "danger" },
  cancelled: { label: t("adminLeave.runStatus.cancelled"), tone: "neutral" },
};

/**
 * The density threshold the org calendar warns at (spec-admin §7.3: "warns >20%
 * dept"). Expressed as a comparison of two SERVER counts — `offToday` from
 * `v_leave_calendar` and `headcount` from `v_admin_employee` — because no
 * deployed relation computes leave density (`v_team_leave_density` does not
 * exist; the employee calendar states the same gap). No percentage is derived or
 * displayed: the screen prints both counts and this returns a boolean.
 */
export const DENSITY_WARN_PARTS = 5 as const;

export function isDenseDay(offCount: number, headcount: number | null): boolean {
  if (headcount === null || headcount <= 0) return false;
  return offCount * DENSITY_WARN_PARTS > headcount;
}
