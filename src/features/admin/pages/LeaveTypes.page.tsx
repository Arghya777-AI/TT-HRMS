/**
 * /admin/leave/types — the leave rulebook (spec-admin §7.1, 20+ attributes).
 *
 * This is the highest-leverage master in the product: every number on it is read
 * by the leave engine at apply time (`leave_requests_submit_guard`), by the
 * accrual job (`accrue_leave`) and by the year-end rollover. Editing
 * `max_carry_forward_days` here silently re-prices every employee's entitlement,
 * which is why:
 *
 *  1. EVERY WRITE ASKS FOR A REASON, always, with D-21's 15-character floor.
 *     `leave_types` is in `audit.reason_required_tables` (migration 006), so the
 *     database refuses a write without `X-Reason` (22023) — the dialog is not
 *     decoration, it is the contract. One audit row per changed field carries it,
 *     and the dialog names the fields that are about to move.
 *  2. THE FORM STATES WHAT EACH NUMBER DOES, in words, next to the number.
 *     `min_notice_days` means nothing; "an application must be filed this many
 *     days ahead" means everything, and getting it wrong is how a venue refuses
 *     leave it meant to allow.
 *  3. SYSTEM-MANAGED TYPES CANNOT BE RETIRED. `leave_types_guard()` raises 0A000
 *     for LWP / CO / OD because the engine writes them, so the row shows the
 *     badge and no retire affordance rather than offering an action that fails.
 *  4. NOTHING IS DERIVED HERE. The grid prints columns; the balances behind a
 *     type are a click away (`/admin/leave/balances?type=…`), counted by Postgres
 *     on that screen rather than added up on this one.
 *
 * `is_comp_off` is deliberately absent from the form: a partial unique index
 * (`uq_leave_types__one_comp_off`) allows exactly one comp-off type per company,
 * and it is seeded. Offering the flag would offer a 23505.
 *
 * @route /admin/leave/types
 */
import { useMemo, useState, type ReactNode } from "react";
import { CalendarDays, Plus } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { SENSITIVE_REASON_LENGTH } from "@/shared/api/query";
import { useAuth } from "@/app/auth/AuthProvider";
import { dash, formatDays } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { LeaveType } from "../api/leave.api";
import { MASTER_STATUS_MAP, MasterBanner } from "../components/MasterScreen";
import { MasterFormSheet } from "../components/MasterFormSheet";
import { Notice } from "../components/Notice";
import {
  CODE_PATTERN,
  COLOUR_PATTERN,
  changeSummary,
  coerceValues,
  validateFields,
  valuesFromRow,
  type FieldErrors,
  type FieldGroup,
  type FieldOption,
  type FormValues,
} from "../masters/fields";
import { accrualRule, leaveUnitLabel, rolloverRule } from "../leave-config-vocab";
import { useDefaultCompanyId } from "../hooks/useMasters";
import { useApprovalChains } from "../hooks/useWorkflowAdmin";
import {
  useArchiveLeaveType,
  useLeaveTypeRulebook,
  useSaveLeaveType,
} from "../hooks/useLeaveConfig";

/** `public.accrual_frequency` (migration 003), in the DB's own order. */
const FREQUENCY_OPTIONS: readonly FieldOption[] = [
  { value: "none", label: t("adminLeave.freq.none") },
  { value: "monthly", label: t("adminLeave.freq.monthly") },
  { value: "quarterly", label: t("adminLeave.freq.quarterly") },
  { value: "half_yearly", label: t("adminLeave.freq.half_yearly") },
  { value: "annual", label: t("adminLeave.freq.annual") },
  { value: "per_worked_days", label: t("adminLeave.freq.per_worked_days") },
  { value: "on_confirmation", label: t("adminLeave.freq.on_confirmation") },
];

/** `ck_lt__unit` allows exactly these three. */
const UNIT_OPTIONS: readonly FieldOption[] = [
  { value: "day", label: t("adminLeave.unit.day") },
  { value: "half_day", label: t("adminLeave.unit.half_day") },
  { value: "hour", label: t("adminLeave.unit.hour") },
];

/** `public.gender` — a restriction, so "no restriction" is the empty option. */
const GENDER_OPTIONS: readonly FieldOption[] = [
  { value: "female", label: t("adminLeave.gender.female") },
  { value: "male", label: t("adminLeave.gender.male") },
  { value: "transgender", label: t("adminLeave.gender.transgender") },
  { value: "prefer_not_to_say", label: t("adminLeave.gender.prefer_not_to_say") },
];

/** `public.employment_type` — the workforce types a type applies to. */
const EMPLOYMENT_TYPE_OPTIONS: readonly FieldOption[] = [
  { value: "permanent", label: t("adminLeave.empType.permanent") },
  { value: "probation", label: t("adminLeave.empType.probation") },
  { value: "contract", label: t("adminLeave.empType.contract") },
  { value: "intern", label: t("adminLeave.empType.intern") },
  { value: "consultant", label: t("adminLeave.empType.consultant") },
  { value: "casual", label: t("adminLeave.empType.casual") },
  { value: "apprentice", label: t("adminLeave.empType.apprentice") },
  { value: "retainer", label: t("adminLeave.empType.retainer") },
];

/**
 * Seed values for a NEW type. They are the table's own defaults (019), so a
 * create writes what the database would have written anyway — nothing is
 * invented, and a blank form cannot post a NOT NULL violation.
 */
const CREATE_DEFAULTS: Readonly<Record<string, string>> = {
  is_active: "true",
  is_paid: "true",
  unit: "day",
  allow_half_day: "true",
  sort_order: "100",
  accrual_frequency: "monthly",
  accrual_start_after_months: "0",
  accrual_on_working_days_basis: "false",
  availing_allowed_during_probation: "false",
  pro_rata_on_join: "true",
  pro_rata_on_exit: "true",
  carry_forward_allowed: "false",
  encashment_allowed: "false",
  min_days_per_request: "0.5",
  min_notice_days: "0",
  max_backdated_days: "2",
  allow_negative_balance: "false",
  max_negative_days: "0",
  sandwich_holidays: "false",
  count_weekly_off_as_leave: "false",
  count_holiday_as_leave: "false",
  min_service_months: "0",
  requires_approval: "true",
};

type Pending =
  | {
      readonly kind: "save";
      readonly mode: "create" | "edit";
      readonly id: string | null;
      readonly values: Record<string, unknown>;
      readonly name: string;
      readonly changes: readonly string[];
    }
  | { readonly kind: "archive"; readonly row: LeaveType };

/** A number the engine reads, or an em dash. Never a bare `0` for "unset". */
function capCell(allowed: boolean, cap: number | null): string {
  if (!allowed) return t("adminLeave.types.no");
  return cap === null ? t("adminLeave.types.uncapped") : formatDays(cap);
}

export default function AdminLeaveTypesPage() {
  const actorName = useAuth().employee?.displayName ?? null;
  const companyId = useDefaultCompanyId();

  const [search, setSearch] = useState("");
  const [retiredOnly, setRetiredOnly] = useState(false);

  const types = useLeaveTypeRulebook(retiredOnly);
  const chains = useApprovalChains({});

  // Form state lives on the screen so a rejected save keeps the typing.
  const [formOpen, setFormOpen] = useState(false);
  const [mode, setMode] = useState<"create" | "edit">("create");
  const [editing, setEditing] = useState<LeaveType | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [original, setOriginal] = useState<FormValues>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const save = useSaveLeaveType();
  const archive = useArchiveLeaveType();

  const chainOptions: readonly FieldOption[] = useMemo(
    () => (chains.data ?? []).map((chain) => ({ value: chain.id, label: chain.name })),
    [chains.data],
  );

  const groups: readonly FieldGroup[] = useMemo(
    () => [
      {
        title: t("adminLeave.types.group.identity"),
        hint: t("adminLeave.types.group.identityHint"),
        fields: [
          {
            name: "code",
            label: t("adminLeave.types.field.code"),
            kind: "code",
            required: true,
            createOnly: true,
            maxLength: 12,
            pattern: CODE_PATTERN,
            help: t("adminLeave.types.help.code"),
          },
          { name: "name", label: t("adminLeave.types.field.name"), kind: "text", required: true, maxLength: 80 },
          {
            name: "description",
            label: t("adminLeave.types.field.description"),
            kind: "textarea",
            maxLength: 500,
            help: t("adminLeave.types.help.description"),
          },
          {
            name: "sort_order",
            label: t("adminLeave.types.field.sortOrder"),
            kind: "number",
            required: true,
            min: 0,
            max: 999,
            help: t("adminLeave.types.help.sortOrder"),
          },
          {
            name: "colour_hex",
            label: t("adminLeave.types.field.colour"),
            kind: "colour",
            pattern: COLOUR_PATTERN,
            help: t("adminLeave.types.help.colour"),
          },
          {
            name: "is_paid",
            label: t("adminLeave.types.field.isPaid"),
            kind: "checkbox",
            help: t("adminLeave.types.help.isPaid"),
          },
          {
            name: "unit",
            label: t("adminLeave.types.field.unit"),
            kind: "select",
            required: true,
            options: UNIT_OPTIONS,
            help: t("adminLeave.types.help.unit"),
          },
          {
            name: "allow_half_day",
            label: t("adminLeave.types.field.allowHalfDay"),
            kind: "checkbox",
            help: t("adminLeave.types.help.allowHalfDay"),
          },
          {
            name: "is_active",
            label: t("adminLeave.types.field.isActive"),
            kind: "checkbox",
            help: t("adminLeave.types.help.isActive"),
          },
        ],
      },
      {
        title: t("adminLeave.types.group.accrual"),
        hint: t("adminLeave.types.group.accrualHint"),
        fields: [
          {
            name: "annual_quota_days",
            label: t("adminLeave.types.field.quota"),
            kind: "decimal",
            min: 0,
            max: 365,
            help: t("adminLeave.types.help.quota"),
          },
          {
            name: "accrual_frequency",
            label: t("adminLeave.types.field.frequency"),
            kind: "select",
            required: true,
            options: FREQUENCY_OPTIONS,
            help: t("adminLeave.types.help.frequency"),
          },
          {
            name: "accrual_days_per_period",
            label: t("adminLeave.types.field.perPeriod"),
            kind: "decimal",
            min: 0,
            max: 31,
            help: t("adminLeave.types.help.perPeriod"),
          },
          {
            name: "accrual_on_working_days_basis",
            label: t("adminLeave.types.field.workedBasis"),
            kind: "checkbox",
            help: t("adminLeave.types.help.workedBasis"),
          },
          {
            name: "accrual_days_per_worked_days",
            label: t("adminLeave.types.field.perWorkedDays"),
            kind: "decimal",
            min: 0,
            max: 365,
            help: t("adminLeave.types.help.perWorkedDays"),
          },
          {
            name: "accrual_start_after_months",
            label: t("adminLeave.types.field.startAfter"),
            kind: "number",
            required: true,
            min: 0,
            max: 60,
            help: t("adminLeave.types.help.startAfter"),
          },
          {
            name: "availing_allowed_during_probation",
            label: t("adminLeave.types.field.probation"),
            kind: "checkbox",
            help: t("adminLeave.types.help.probation"),
          },
          {
            name: "pro_rata_on_join",
            label: t("adminLeave.types.field.proRataJoin"),
            kind: "checkbox",
            help: t("adminLeave.types.help.proRataJoin"),
          },
          {
            name: "pro_rata_on_exit",
            label: t("adminLeave.types.field.proRataExit"),
            kind: "checkbox",
            help: t("adminLeave.types.help.proRataExit"),
          },
          {
            name: "max_balance_days",
            label: t("adminLeave.types.field.maxBalance"),
            kind: "decimal",
            min: 0,
            max: 999,
            help: t("adminLeave.types.help.maxBalance"),
          },
        ],
      },
      {
        title: t("adminLeave.types.group.yearEnd"),
        hint: t("adminLeave.types.group.yearEndHint"),
        fields: [
          {
            name: "carry_forward_allowed",
            label: t("adminLeave.types.field.cfAllowed"),
            kind: "checkbox",
            help: t("adminLeave.types.help.cfAllowed"),
          },
          {
            name: "max_carry_forward_days",
            label: t("adminLeave.types.field.cfCap"),
            kind: "decimal",
            min: 0,
            max: 999,
            help: t("adminLeave.types.help.cfCap"),
          },
          {
            name: "carry_forward_expiry_months",
            label: t("adminLeave.types.field.cfExpiry"),
            kind: "number",
            min: 0,
            max: 60,
            help: t("adminLeave.types.help.cfExpiry"),
          },
          {
            name: "encashment_allowed",
            label: t("adminLeave.types.field.encashAllowed"),
            kind: "checkbox",
            help: t("adminLeave.types.help.encashAllowed"),
          },
          {
            name: "max_encashment_days",
            label: t("adminLeave.types.field.encashCap"),
            kind: "decimal",
            min: 0,
            max: 999,
            help: t("adminLeave.types.help.encashCap"),
          },
        ],
      },
      {
        title: t("adminLeave.types.group.request"),
        hint: t("adminLeave.types.group.requestHint"),
        fields: [
          {
            name: "min_days_per_request",
            label: t("adminLeave.types.field.minDays"),
            kind: "decimal",
            required: true,
            min: 0,
            max: 365,
            help: t("adminLeave.types.help.minDays"),
          },
          {
            name: "max_days_per_request",
            label: t("adminLeave.types.field.maxDays"),
            kind: "decimal",
            min: 0,
            max: 365,
            help: t("adminLeave.types.help.maxDays"),
          },
          {
            name: "max_consecutive_days",
            label: t("adminLeave.types.field.maxConsecutive"),
            kind: "decimal",
            min: 0,
            max: 365,
            help: t("adminLeave.types.help.maxConsecutive"),
          },
          {
            name: "min_notice_days",
            label: t("adminLeave.types.field.notice"),
            kind: "number",
            required: true,
            min: 0,
            max: 180,
            help: t("adminLeave.types.help.notice"),
          },
          {
            name: "max_backdated_days",
            label: t("adminLeave.types.field.backdated"),
            kind: "number",
            required: true,
            min: 0,
            max: 180,
            help: t("adminLeave.types.help.backdated"),
          },
          {
            name: "requires_document_after_days",
            label: t("adminLeave.types.field.documentAfter"),
            kind: "decimal",
            min: 0,
            max: 365,
            help: t("adminLeave.types.help.documentAfter"),
          },
          {
            name: "allow_negative_balance",
            label: t("adminLeave.types.field.negative"),
            kind: "checkbox",
            help: t("adminLeave.types.help.negative"),
          },
          {
            name: "max_negative_days",
            label: t("adminLeave.types.field.negativeCap"),
            kind: "decimal",
            required: true,
            min: 0,
            max: 365,
            help: t("adminLeave.types.help.negativeCap"),
          },
          {
            name: "sandwich_holidays",
            label: t("adminLeave.types.field.sandwich"),
            kind: "checkbox",
            help: t("adminLeave.types.help.sandwich"),
          },
          {
            name: "count_weekly_off_as_leave",
            label: t("adminLeave.types.field.countOff"),
            kind: "checkbox",
            help: t("adminLeave.types.help.countOff"),
          },
          {
            name: "count_holiday_as_leave",
            label: t("adminLeave.types.field.countHoliday"),
            kind: "checkbox",
            help: t("adminLeave.types.help.countHoliday"),
          },
        ],
      },
      {
        title: t("adminLeave.types.group.eligibility"),
        hint: t("adminLeave.types.group.eligibilityHint"),
        fields: [
          {
            name: "gender_restriction",
            label: t("adminLeave.types.field.gender"),
            kind: "select",
            options: GENDER_OPTIONS,
            help: t("adminLeave.types.help.gender"),
          },
          {
            name: "min_service_months",
            label: t("adminLeave.types.field.minService"),
            kind: "number",
            required: true,
            min: 0,
            max: 480,
            help: t("adminLeave.types.help.minService"),
          },
          {
            name: "max_times_in_service",
            label: t("adminLeave.types.field.maxTimes"),
            kind: "number",
            min: 1,
            max: 99,
            help: t("adminLeave.types.help.maxTimes"),
          },
          {
            name: "applies_to_employment_types",
            label: t("adminLeave.types.field.employmentTypes"),
            kind: "multi",
            options: EMPLOYMENT_TYPE_OPTIONS,
            help: t("adminLeave.types.help.employmentTypes"),
            wide: true,
          },
          {
            name: "requires_approval",
            label: t("adminLeave.types.field.requiresApproval"),
            kind: "checkbox",
            help: t("adminLeave.types.help.requiresApproval"),
          },
          {
            name: "approval_chain_id",
            label: t("adminLeave.types.field.chain"),
            kind: "select",
            options: chainOptions,
            help: t("adminLeave.types.help.chain"),
            wide: true,
          },
        ],
      },
    ],
    [chainOptions],
  );

  const rows = useMemo(() => {
    const all = types.data ?? [];
    const needle = search.trim().toLowerCase();
    if (needle === "") return all;
    // A presentation filter over an already-loaded master (ten rows here), not a
    // request per keystroke and not arithmetic on anything.
    return all.filter(
      (row) =>
        row.name.toLowerCase().includes(needle) || row.code.toLowerCase().includes(needle),
    );
  }, [types.data, search]);

  function openCreate(): void {
    const base = valuesFromRow(groups, null);
    setMode("create");
    setEditing(null);
    setValues({ ...base, ...CREATE_DEFAULTS });
    setOriginal({ ...base, ...CREATE_DEFAULTS });
    setErrors({});
    setFormError(null);
    save.reset();
    setFormOpen(true);
  }

  function openEdit(row: LeaveType): void {
    const base = valuesFromRow(groups, row as unknown as Record<string, unknown>);
    setMode("edit");
    setEditing(row);
    setValues(base);
    setOriginal(base);
    setErrors({});
    setFormError(null);
    save.reset();
    setFormOpen(true);
  }

  /**
   * The cross-field rules a form CAN break. Each one mirrors either a DB CHECK or
   * an engine behaviour, so the round trip is spent on real work rather than on a
   * constraint that could have been explained in the browser.
   */
  function validateForm(v: FormValues): string | null {
    const num = (name: string): number | null => {
      const raw = (v[name] ?? "").trim();
      if (raw === "") return null;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const on = (name: string): boolean => v[name] === "true";

    const minDays = num("min_days_per_request");
    const maxDays = num("max_days_per_request");
    if (minDays !== null && maxDays !== null && minDays > maxDays)
      return t("adminLeave.types.err.minOverMax");

    if (!on("carry_forward_allowed") && num("max_carry_forward_days") !== null)
      return t("adminLeave.types.err.cfCapWithoutCf");
    if (!on("encashment_allowed") && num("max_encashment_days") !== null)
      return t("adminLeave.types.err.encashCapWithoutEncash");
    if (!on("allow_negative_balance") && (num("max_negative_days") ?? 0) > 0)
      return t("adminLeave.types.err.negativeWithoutFlag");

    const frequency = v["accrual_frequency"] ?? "";
    const perPeriod = num("accrual_days_per_period");
    const periodic = ["monthly", "quarterly", "half_yearly", "annual"].includes(frequency);
    if (periodic && perPeriod === null) return t("adminLeave.types.err.perPeriodRequired");
    if (frequency === "none" && perPeriod !== null) return t("adminLeave.types.err.perPeriodUnused");

    if (on("accrual_on_working_days_basis") && num("accrual_days_per_worked_days") === null)
      return t("adminLeave.types.err.workedBasisNeedsRate");

    const cfCap = num("max_carry_forward_days");
    const maxBalance = num("max_balance_days");
    if (cfCap !== null && maxBalance !== null && cfCap > maxBalance)
      return t("adminLeave.types.err.cfOverBalance");

    return null;
  }

  function submitForm(): void {
    const fieldErrors = validateFields(groups, values, mode);
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) return;

    const crossField = validateForm(values);
    setFormError(crossField);
    if (crossField !== null) return;

    let payload = coerceValues(groups, values, mode, mode === "edit" ? original : null);
    if (mode === "create") {
      if (companyId === null) {
        setFormError(t("adminLeave.types.err.noCompany"));
        return;
      }
      payload = { ...payload, company_id: companyId };
    }
    if (mode === "edit" && Object.keys(payload).length === 0) {
      setFormError(t("adminLeave.types.err.noChanges"));
      return;
    }

    setPending({
      kind: "save",
      mode,
      id: editing?.id ?? null,
      values: payload,
      name: (values["name"] ?? editing?.name ?? "").trim(),
      changes: mode === "edit" ? changeSummary(groups, original, values) : [],
    });
  }

  async function runSave(action: Extract<Pending, { kind: "save" }>, reason: string) {
    try {
      await save.saveAsync({ id: action.id, values: action.values }, reason);
      toast.success(
        action.mode === "create"
          ? t("adminLeave.types.toast.created", { name: action.name })
          : t("adminLeave.types.toast.saved", { name: action.name }),
      );
      setPending(null);
      setFormOpen(false);
    } catch {
      // The sentence is on `save.userMessage`, inside the dialog; keep the form.
      setPending(null);
    }
  }

  async function runArchive(row: LeaveType, reason: string) {
    try {
      await archive.saveAsync({ id: row.id, name: row.name }, reason);
      toast.success(t("adminLeave.types.toast.retired", { name: row.name }));
      setPending(null);
    } catch {
      /* surfaced in the dialog via archive.userMessage */
    }
  }

  /**
   * Not memoised, and deliberately so: the action cells close over `openEdit`,
   * which is recreated every render, so a `useMemo` here would either be a lie
   * about its dependencies or would have to be silenced. The grid is ten rows.
   */
  const columns: DataGridColumn<LeaveType>[] = [
    {
      key: "name",
      header: t("adminLeave.types.col.type"),
      width: "15rem",
      sortable: true,
      sortValue: (row) => row.name,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="flex items-center gap-2">
            {row.colour_hex === null ? null : (
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full border"
                style={{ backgroundColor: row.colour_hex }}
                aria-hidden
              />
            )}
            <span className="font-medium">{row.name}</span>
          </span>
          <span className="num text-xs text-muted-foreground">{row.code}</span>
        </span>
      ),
    },
    {
      key: "is_paid",
      header: t("adminLeave.types.col.treatment"),
      width: "11rem",
      hideBelow: "md",
      render: (row) => (
        <span className="flex flex-col leading-tight text-xs">
          <span>{row.is_paid ? t("adminLeave.types.paid") : t("adminLeave.types.unpaid")}</span>
          <span className="text-muted-foreground">
            {leaveUnitLabel(row.unit)}
            {row.allow_half_day ? ` · ${t("adminLeave.types.halfDayOk")}` : ""}
          </span>
        </span>
      ),
    },
    {
      key: "annual_quota_days",
      header: t("adminLeave.types.col.quota"),
      width: "7rem",
      align: "right",
      sortable: true,
      render: (row) => dash(row.annual_quota_days, formatDays),
    },
    {
      key: "accrual",
      header: t("adminLeave.types.col.accrual"),
      width: "16rem",
      hideBelow: "lg",
      render: (row) => <span className="text-xs">{accrualRule(row)}</span>,
    },
    {
      key: "max_carry_forward_days",
      header: t("adminLeave.types.col.carry"),
      width: "8rem",
      align: "right",
      render: (row) => (
        <span className="num">{capCell(row.carry_forward_allowed, row.max_carry_forward_days)}</span>
      ),
    },
    {
      key: "max_encashment_days",
      header: t("adminLeave.types.col.encash"),
      width: "8rem",
      align: "right",
      hideBelow: "md",
      render: (row) => (
        <span className="num">{capCell(row.encashment_allowed, row.max_encashment_days)}</span>
      ),
    },
    {
      key: "yearEnd",
      header: t("adminLeave.types.col.yearEnd"),
      width: "18rem",
      hideBelow: "lg",
      render: (row) => <span className="text-xs">{rolloverRule(row)}</span>,
    },
    {
      key: "requires_approval",
      header: t("adminLeave.types.col.approval"),
      width: "9rem",
      hideBelow: "lg",
      render: (row) =>
        row.requires_approval
          ? t("adminLeave.types.approvalChain")
          : t("adminLeave.types.autoApproved"),
    },
    {
      key: "status",
      header: t("adminLeave.types.col.status"),
      width: "9rem",
      render: (row) => (
        <span className="flex flex-col items-start gap-1">
          <StatusChip
            status={row.deleted_at !== null ? "retired" : row.is_active ? "active" : "inactive"}
            map={MASTER_STATUS_MAP}
          />
          {row.is_system_managed ? (
            <span className="text-xs text-muted-foreground">
              {t("adminLeave.types.systemManaged")}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "actions",
      header: t("adminLeave.types.col.actions"),
      align: "right",
      width: "16rem",
      render: (row) => (
        <span className="flex justify-end gap-1" onClick={(event) => event.stopPropagation()}>
          <Button variant="outline" size="sm" asChild>
            <Link to={`/admin/leave/balances?type=${row.id}`}>
              {t("adminLeave.types.action.balances")}
            </Link>
          </Button>
          <Button variant="outline" size="sm" onClick={() => openEdit(row)}>
            {t("adminLeave.types.action.edit")}
          </Button>
          {row.deleted_at !== null || row.is_system_managed ? null : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPending({ kind: "archive", row })}
            >
              {t("adminLeave.types.action.retire")}
            </Button>
          )}
        </span>
      ),
    },
  ];

  const filtersOn = search.trim() !== "" || retiredOnly;

  return (
    <div className="container py-6">
      <PageHeader
        icon={CalendarDays}
        title={t("adminLeave.types.title")}
        subtitle={t("adminLeave.types.subtitle")}
        actions={
          <Button onClick={openCreate}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden />
            {t("adminLeave.types.action.new")}
          </Button>
        }
      />

      <MasterBanner>{t("adminLeave.types.banner")}</MasterBanner>

      <Notice tone="info" className="mb-4">
        {t("adminLeave.types.reasonNotice", { min: SENSITIVE_REASON_LENGTH })}
      </Notice>

      <StateBoundary
        loading={types.isLoading}
        error={types.error ?? undefined}
        onRetry={() => void types.refetch()}
        partialError={chains.error ?? undefined}
        partialLabel={t("adminLeave.types.partialChains")}
        skeletonRows={6}
      >
        <DataGrid
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          pageSize={25}
          onRowClick={(row) => openEdit(row)}
          toolbar={
            <>
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("adminLeave.types.search")}
                aria-label={t("adminLeave.types.search")}
                className="h-9 w-full sm:w-64"
              />
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={retiredOnly}
                  onChange={(event) => setRetiredOnly(event.target.checked)}
                  className="h-4 w-4 rounded border-input text-primary"
                />
                {t("adminLeave.types.filter.retiredOnly")}
              </label>
            </>
          }
          emptyState={
            filtersOn ? (
              <EmptyState
                icon={CalendarDays}
                title={t("adminLeave.types.empty.filtered")}
                hint={t("adminLeave.types.empty.filteredHint")}
              />
            ) : (
              <EmptyState
                icon={CalendarDays}
                title={t("adminLeave.types.empty.title")}
                hint={t("adminLeave.types.empty.hint")}
                action={<Button onClick={openCreate}>{t("adminLeave.types.action.new")}</Button>}
              />
            )
          }
        />
      </StateBoundary>

      <MasterFormSheet
        open={formOpen}
        mode={mode}
        entityLabel={t("adminLeave.types.entity")}
        rowName={editing?.name ?? null}
        groups={groups}
        values={values}
        errors={errors}
        pending={save.isPending}
        serverMessage={save.userMessage}
        formError={formError}
        banner={
          <MasterBanner>
            {editing !== null && editing.is_system_managed
              ? t("adminLeave.types.formBanner.system")
              : t("adminLeave.types.formBanner")}
          </MasterBanner>
        }
        onChange={(name, value) => {
          setValues((prev) => ({ ...prev, [name]: value }));
          setErrors((prev) => {
            if (prev[name] === undefined) return prev;
            const next = { ...prev };
            delete next[name];
            return next;
          });
          setFormError(null);
        }}
        onSubmit={submitForm}
        onClose={() => {
          setFormOpen(false);
          setPending(null);
        }}
      />

      {reasonDialog()}
    </div>
  );

  function reasonDialog(): ReactNode {
    if (pending === null) return null;

    if (pending.kind === "save") {
      const description =
        pending.mode === "create"
          ? t("adminLeave.types.dialog.create", { name: pending.name })
          : pending.changes.length === 0
            ? t("adminLeave.types.err.noChanges")
            : t("adminLeave.types.dialog.changes", { changes: pending.changes.join("; ") });
      return (
        <ReasonDialog
          open
          title={
            pending.mode === "create"
              ? t("adminLeave.types.dialog.createTitle")
              : t("adminLeave.types.dialog.editTitle", { name: pending.name })
          }
          description={description}
          actorName={actorName}
          minLength={SENSITIVE_REASON_LENGTH}
          confirmLabel={t("adminLeave.types.dialog.confirm")}
          pending={save.isPending}
          errorMessage={save.userMessage}
          onConfirm={(reason) => void runSave(pending, reason)}
          onCancel={() => {
            save.reset();
            setPending(null);
          }}
        />
      );
    }

    return (
      <ReasonDialog
        open
        title={t("adminLeave.types.retire.title", { name: pending.row.name })}
        description={t("adminLeave.types.retire.description", { name: pending.row.name })}
        actorName={actorName}
        minLength={SENSITIVE_REASON_LENGTH}
        confirmLabel={t("adminLeave.types.retire.confirm")}
        pending={archive.isPending}
        errorMessage={archive.userMessage}
        onConfirm={(reason) => void runArchive(pending.row, reason)}
        onCancel={() => {
          archive.reset();
          setPending(null);
        }}
      />
    );
  }
}
