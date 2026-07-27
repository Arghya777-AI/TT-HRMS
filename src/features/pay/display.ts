/**
 * display.ts — presentation vocabulary for the pay screens.
 *
 * Two jobs, and nothing else:
 *  1. Turn a DB value into the human label the catalogue holds. No raw enum,
 *     bucket letter or component code ever reaches the screen (DR-16/DR-53).
 *  2. GROUP already-fetched payslip line rows by their `line_kind`.
 *
 * There is no arithmetic here, deliberately. Grouping picks rows; it never adds
 * them. Every total the payslip shows — gross, deductions, net, employer
 * contributions, CTC, YTD — is a header column of `v_payslip_detail`, and the
 * A/B/C bucket totals of the structure are window functions inside
 * `v_employee_current_salary`. If a total is not in a view, the screen says so
 * rather than summing the rows it happens to have (frontend-contract §5).
 */
import type { StatusChipEntry } from "@/shared/ui/StatusChip";
import { t, type MessageKey } from "@/shared/i18n/en";
import type { CurrentSalaryLine, PayslipLineKind, PayslipLineRow } from "./api/pay.api";

// -----------------------------------------------------------------------------
// Payment state / mode / revision kind
// -----------------------------------------------------------------------------

/** `payslips.payment_status` — ck_payslips__payment_status (migration 022). */
const PAYMENT_STATUS_KEYS: Readonly<Record<string, MessageKey>> = {
  pending: "pay.status.pending",
  in_batch: "pay.status.inBatch",
  paid: "pay.status.paid",
  failed: "pay.status.failed",
  held: "pay.status.held",
  reversed: "pay.status.reversed",
};

const PAYMENT_STATUS_TONES: Readonly<Record<string, StatusChipEntry["tone"]>> = {
  pending: "warn",
  in_batch: "info",
  paid: "success",
  failed: "danger",
  held: "warn",
  reversed: "danger",
};

/** The chip map for the payslip list and the viewer masthead. */
export function paymentStatusChipMap(): Record<string, StatusChipEntry> {
  const map: Record<string, StatusChipEntry> = {};
  for (const [value, key] of Object.entries(PAYMENT_STATUS_KEYS)) {
    map[value] = { label: t(key), tone: PAYMENT_STATUS_TONES[value] ?? "neutral" };
  }
  return map;
}

/** `payment_mode` enum (migration 003). */
const PAYMENT_MODE_KEYS: Readonly<Record<string, MessageKey>> = {
  bank_transfer: "pay.mode.bankTransfer",
  cash: "pay.mode.cash",
  cheque: "pay.mode.cheque",
  upi: "pay.mode.upi",
};

export function paymentModeLabel(mode: string | null): string {
  if (mode === null) return t("common.empty");
  const key = PAYMENT_MODE_KEYS[mode];
  return key === undefined ? humanise(mode) : t(key);
}

/** `employee_salary_revisions.revision_kind` — ck_esr__kind (migration 021). */
const REVISION_KIND_KEYS: Readonly<Record<string, MessageKey>> = {
  initial: "pay.revisionKind.initial",
  annual_increment: "pay.revisionKind.annualIncrement",
  promotion: "pay.revisionKind.promotion",
  market_correction: "pay.revisionKind.marketCorrection",
  role_change: "pay.revisionKind.roleChange",
  confirmation: "pay.revisionKind.confirmation",
  statutory_revision: "pay.revisionKind.statutoryRevision",
  correction: "pay.revisionKind.correction",
  demotion: "pay.revisionKind.demotion",
};

export function revisionKindLabel(kind: string | null): string {
  if (kind === null) return t("common.empty");
  const key = REVISION_KIND_KEYS[kind];
  return key === undefined ? humanise(kind) : t(key);
}

/** `salary_components.ctc_bucket` — A gross, B variable, C employer. */
export function ctcBucketLabel(bucket: string | null): string {
  switch (bucket) {
    case "A":
      return t("pay.bucket.a");
    case "B":
      return t("pay.bucket.b");
    case "C":
      return t("pay.bucket.c");
    default:
      return t("common.empty");
  }
}

/** Last-resort humanisation so an unmapped value is still never a bare code. */
function humanise(value: string): string {
  const words = value.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// -----------------------------------------------------------------------------
// Payslip line grouping (selection, never summation)
// -----------------------------------------------------------------------------

/**
 * `v_payslip_detail` is LINE grain with the header repeated, so the header is
 * read off any row. `null` when the payslip is not visible (RLS) or absent.
 */
export function payslipHeader(rows: readonly PayslipLineRow[]): PayslipLineRow | null {
  return rows[0] ?? null;
}

/**
 * The rows of one section, in the order payroll sequenced them.
 *
 * A payslip with no lines at all still yields one row from the view's LEFT JOIN
 * (every line column null) — that row is not a line and is filtered out here.
 */
export function linesOfKind(
  rows: readonly PayslipLineRow[],
  kind: PayslipLineKind,
): PayslipLineRow[] {
  return rows.filter((row) => row.line_id !== null && row.line_kind === kind);
}

/** Line kinds that are neither earnings, deductions nor employer contributions. */
export const OTHER_LINE_KINDS: readonly PayslipLineKind[] = [
  "reimbursement",
  "arrear",
  "recovery",
  "informational",
];

const LINE_KIND_KEYS: Readonly<Record<PayslipLineKind, MessageKey>> = {
  earning: "pay.lineKind.earning",
  deduction: "pay.lineKind.deduction",
  employer_contribution: "pay.lineKind.employerContribution",
  reimbursement: "pay.lineKind.reimbursement",
  informational: "pay.lineKind.informational",
  arrear: "pay.lineKind.arrear",
  recovery: "pay.lineKind.recovery",
};

export function lineKindLabel(kind: PayslipLineKind): string {
  return t(LINE_KIND_KEYS[kind]);
}

// -----------------------------------------------------------------------------
// Salary structure grouping
// -----------------------------------------------------------------------------

/**
 * The component lines of the current structure, in `sequence` order and with
 * the "no lines yet" row (all line columns null) dropped.
 *
 * The revision header — gross, employer contribution, CTC, and the A/B/C bucket
 * totals — is identical on every row, so callers read it from `rows[0]`.
 */
export function structureLines(rows: readonly CurrentSalaryLine[]): CurrentSalaryLine[] {
  return rows.filter((row) => row.line_id !== null);
}
