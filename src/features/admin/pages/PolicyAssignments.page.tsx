/**
 * A-6.6 · /admin/time/assignments — Policy Assignments: which policy applies to
 * whom, from when.
 *
 * ONE table binds everything: `public.policy_assignments` (migration 014 §6).
 * `assignment_kind` says what is being bound, `policy_id` is polymorphic per kind
 * (no foreign key — the label has to be looked up in that kind's own table),
 * `scope` + one target column say to whom, and `[effective_from, effective_to]`
 * says from when. There is no `is_active` and no `is_current`: a binding is live
 * because a date falls inside its window, which is why this screen has an "as at"
 * date rather than a status filter.
 *
 * WHY NOTHING HERE IS DELETED. The attendance engine can be asked to recompute
 * any past day, and it re-resolves the policy for THAT day
 * (`f_recompute_attendance_day` → `resolve_policy`). Delete the binding that
 * governed March and March stops reproducing. So the two write paths are
 * END-DATE (the row keeps answering for the dates it governed) and ARCHIVE (D-23
 * soft delete, for a row created in error), and both carry a typed reason of 15
 * characters that lands in `policy_assignments.reason` as well as in `audit_log`.
 *
 * PRECEDENCE IS NOT DECIDED HERE. The narrowness ladder shown against each row is
 * `resolve_policy`'s own ORDER BY, transcribed once in `time-policy.api.ts`
 * (`SCOPE_RANK`). Which binding actually wins for one person on one date is a
 * question only the database answers — that is what /admin/time/resolver is for,
 * and every row links to it.
 *
 * @route /admin/time/assignments
 */
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Cog, Plus, ShieldAlert, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { SENSITIVE_REASON_LENGTH } from "@/shared/api/query";
import { useAuth } from "@/app/auth/AuthProvider";
import { fmtCivilDate, fmtDateTime, nowIstDate } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { SelectField, TextField, type SelectOption } from "../components/Field";
import { EMPLOYMENT_TYPE_LABELS, employmentTypeValues } from "../api/employees.api";
import {
  KIND_POLICY_TABLE,
  SCOPE_RANK,
  assignmentKindValues,
  assignmentScopeValues,
  type AssignmentCreateInput,
  type AssignmentFilters,
  type AssignmentKind,
  type AssignmentScope,
  type PolicyAssignment,
} from "../api/time-policy.api";
import {
  BINDING_CHIP,
  KIND_CONSUMER,
  bindingState,
  employmentTypeLabel,
  kindIsRead,
  kindLabel,
  scopeLabel,
  scopeRank,
  windowLabel,
} from "../time-policy-display";
import { useCompanies, usePayPeriods, useRefOptions } from "../hooks/useMasters";
import {
  targetOf,
  useAssignmentArchive,
  useAssignmentCreate,
  useAssignmentEmployeeOptions,
  useAssignmentEndDate,
  useAssignmentLabels,
  useAssignmentRestore,
  usePolicyAssignmentCount,
  usePolicyAssignments,
} from "../hooks/useTimePolicy";
import { useReasonPrompt } from "../hooks/useReasonPrompt";

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Kinds a binding can be CREATED for. `leave_policy` is deliberately absent:
 * `ck_pa__kind` accepts it, but no `leave_policies` table is deployed, so there is
 * no id to pick and a create form offering it would be a dead end. Existing
 * `leave_policy` rows, if any were ever inserted, still list and can be archived.
 */
const CREATABLE_KINDS: readonly AssignmentKind[] = [
  "attendance_policy",
  "weekly_off_rule",
  "holiday_calendar",
  "shift",
  "pay_period",
];

interface FormState {
  kind: AssignmentKind;
  policyId: string;
  scope: AssignmentScope;
  target: string;
  effectiveFrom: string;
  effectiveTo: string;
  priority: string;
}

type FieldErrors = Record<string, string | undefined>;

/** The pending write a reason is being collected for. */
type PendingWrite =
  | { readonly action: "create"; readonly summary: string; readonly input: AssignmentCreateInput }
  | {
      readonly action: "endDate";
      readonly summary: string;
      readonly input: { readonly id: string; readonly effectiveTo: string };
    }
  | { readonly action: "archive"; readonly summary: string; readonly input: { readonly id: string } }
  | { readonly action: "restore"; readonly summary: string; readonly input: { readonly id: string } };

function isKind(value: string | null): value is AssignmentKind {
  return value !== null && assignmentKindValues.some((kind) => kind === value);
}

function isScope(value: string | null): value is AssignmentScope {
  return value !== null && assignmentScopeValues.some((scope) => scope === value);
}

function parsePriority(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 0 && value <= 999 ? value : null;
}

export default function PolicyAssignmentsPage() {
  const { employee } = useAuth();
  const [params, setParams] = useSearchParams();

  const kindFilter = isKind(params.get("kind")) ? (params.get("kind") as AssignmentKind) : null;
  const scopeFilter = isScope(params.get("scope")) ? (params.get("scope") as AssignmentScope) : null;
  const archivedView = params.get("view") === "archived";
  const dateParam = params.get("date");
  const asOf = dateParam !== null && CIVIL_DATE.test(dateParam) ? dateParam : nowIstDate();

  function patch(next: Record<string, string | null>): void {
    const merged = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === "") merged.delete(key);
      else merged.set(key, value);
    }
    setParams(merged, { replace: true });
  }

  const filters: AssignmentFilters = useMemo(
    () => ({
      ...(kindFilter !== null ? { kinds: [kindFilter] } : {}),
      ...(scopeFilter !== null ? { scopes: [scopeFilter] } : {}),
      archived: archivedView,
    }),
    [kindFilter, scopeFilter, archivedView],
  );

  const list = usePolicyAssignments(filters);
  const liveCount = usePolicyAssignmentCount({ ...filters, archived: false });
  const archivedCount = usePolicyAssignmentCount({ ...filters, archived: true });

  const rows = useMemo(() => list.data ?? [], [list.data]);
  const labels = useAssignmentLabels(rows);

  // ── form state ───────────────────────────────────────────────────────────
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>({
    kind: "attendance_policy",
    policyId: "",
    scope: "department",
    target: "",
    effectiveFrom: nowIstDate(),
    effectiveTo: "",
    priority: "100",
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [ending, setEnding] = useState<{ row: PolicyAssignment; date: string } | null>(null);

  // Pickers, each gated so a page view that never opens the form reads nothing.
  const policyLists = {
    attendance_policy: useRefOptions("attendancePolicies", formOpen && form.kind === "attendance_policy"),
    weekly_off_rule: useRefOptions("weeklyOffRules", formOpen && form.kind === "weekly_off_rule"),
    holiday_calendar: useRefOptions("holidayCalendars", formOpen && form.kind === "holiday_calendar"),
    shift: useRefOptions("shifts", formOpen && form.kind === "shift"),
  };
  const payPeriods = usePayPeriods();
  const companies = useCompanies();
  const scopeLists = {
    location: useRefOptions("locations", formOpen && form.scope === "location"),
    department: useRefOptions("departments", formOpen && form.scope === "department"),
    section: useRefOptions("sections", formOpen && form.scope === "section"),
    grade: useRefOptions("grades", formOpen && form.scope === "grade"),
    designation: useRefOptions("designations", formOpen && form.scope === "designation"),
  };
  const employeeOptions = useAssignmentEmployeeOptions(formOpen && form.scope === "employee");

  const prompt = useReasonPrompt<PendingWrite>();
  const { ask, close: closePrompt, target: pendingWrite, isOpen: promptOpen } = prompt;

  function onWritten(message: string): void {
    closePrompt();
    setEnding(null);
    setFormOpen(false);
    toast.success(message);
  }

  const create = useAssignmentCreate(() => onWritten(t("timeAudit.assign.toast.created")));
  const endDate = useAssignmentEndDate(() => onWritten(t("timeAudit.assign.toast.endDated")));
  const archive = useAssignmentArchive(() => onWritten(t("timeAudit.assign.toast.archived")));
  const restore = useAssignmentRestore(() => onWritten(t("timeAudit.assign.toast.restored")));

  const writePending =
    create.isPending || endDate.isPending || archive.isPending || restore.isPending;
  const writeError =
    create.userMessage ?? endDate.userMessage ?? archive.userMessage ?? restore.userMessage;

  // ── derived figures, all over the EXACT series in the grid ───────────────
  const liveOnDate = useMemo(
    () => rows.filter((row) => bindingState(row, asOf) === "live"),
    [rows, asOf],
  );
  const companyDefaults = useMemo(() => {
    const kinds = new Set<string>();
    for (const row of liveOnDate) if (row.scope === "company") kinds.add(row.assignment_kind);
    return kinds;
  }, [liveOnDate]);
  const unreadKinds = useMemo(() => {
    const kinds = new Set<string>();
    for (const row of rows) {
      if (!kindIsRead(row.assignment_kind)) kinds.add(row.assignment_kind);
    }
    return [...kinds];
  }, [rows]);

  const scopeNumbers = t("timeAudit.assign.scopeNumbers", {
    n: formatNumber(rows.length),
    date: fmtCivilDate(asOf),
  });

  // ── labels for one row ───────────────────────────────────────────────────
  function policyText(row: PolicyAssignment): { name: string; code: string | null } {
    const ref = labels.data?.policies.get(row.policy_id);
    if (ref !== undefined) return { name: ref.name, code: ref.code };
    if (KIND_POLICY_TABLE[row.assignment_kind as AssignmentKind] === undefined) {
      return { name: t("timeAudit.assign.noPolicyTable"), code: null };
    }
    return { name: t("timeAudit.assign.policyUnknown"), code: null };
  }

  function targetText(row: PolicyAssignment): string {
    const target = targetOf(row);
    if (target === null) return dash(null);
    if (row.scope === "employment_type") return employmentTypeLabel(target);
    if (row.scope === "employee") {
      const person = labels.data?.employees.get(target);
      return person === undefined ? t("timeAudit.assign.targetUnknown") : person.display_name;
    }
    const ref = labels.data?.scopes.get(target);
    return ref === undefined ? t("timeAudit.assign.targetUnknown") : ref.name;
  }

  function summaryOf(row: PolicyAssignment): string {
    return t("timeAudit.assign.summary", {
      kind: kindLabel(row.assignment_kind),
      policy: policyText(row).name,
      scope: scopeLabel(row.scope),
      target: targetText(row),
    });
  }

  // ── the create form ──────────────────────────────────────────────────────
  function setField<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  /**
   * The two dependent pickers. Plain expressions rather than `useMemo`: each is a
   * map over at most a few dozen reference rows, and memoising it would mean
   * declaring five query results as dependencies for a saving of nothing.
   */
  const policyChoices: SelectOption[] =
    form.kind === "pay_period"
      ? (payPeriods.data ?? []).map((period) => ({ value: period.id, label: period.name }))
      : (policyLists[form.kind as keyof typeof policyLists]?.data ?? []).map((ref) => ({
          value: ref.id,
          label: ref.name,
        }));

  const targetChoices: SelectOption[] =
    form.scope === "company"
      ? (companies.data ?? []).map((row) => ({ value: row.id, label: row.name }))
      : form.scope === "employment_type"
        ? employmentTypeValues.map((value) => ({ value, label: EMPLOYMENT_TYPE_LABELS[value] }))
        : form.scope === "employee"
          ? (employeeOptions.data ?? []).map((row) => ({
              value: row.id,
              label: t("timeAudit.common.personOption", {
                name: row.display_name,
                code: row.employee_code,
              }),
            }))
          : (scopeLists[form.scope as keyof typeof scopeLists]?.data ?? []).map((ref) => ({
              value: ref.id,
              label: ref.name,
            }));

  function submitForm(): void {
    const found: FieldErrors = {};
    if (form.policyId === "") found.policyId = t("timeAudit.assign.error.policy");
    if (form.target === "") found.target = t("timeAudit.assign.error.target");
    if (!CIVIL_DATE.test(form.effectiveFrom)) found.effectiveFrom = t("timeAudit.assign.error.from");
    if (form.effectiveTo !== "" && !CIVIL_DATE.test(form.effectiveTo)) {
      found.effectiveTo = t("timeAudit.assign.error.to");
    }
    if (
      form.effectiveTo !== "" &&
      CIVIL_DATE.test(form.effectiveTo) &&
      form.effectiveTo < form.effectiveFrom
    ) {
      found.effectiveTo = t("timeAudit.assign.error.range");
    }
    if (parsePriority(form.priority) === null) found.priority = t("timeAudit.assign.error.priority");
    setErrors(found);
    if (Object.values(found).some((value) => value !== undefined)) return;

    const priority = parsePriority(form.priority);
    if (priority === null) return;
    create.reset();
    const policyName =
      policyChoices.find((choice) => choice.value === form.policyId)?.label ?? form.policyId;
    const targetName =
      targetChoices.find((choice) => choice.value === form.target)?.label ?? form.target;
    ask({
      action: "create",
      summary: t("timeAudit.assign.summary", {
        kind: kindLabel(form.kind),
        policy: policyName,
        scope: scopeLabel(form.scope),
        target: targetName,
      }),
      input: {
        kind: form.kind,
        policyId: form.policyId,
        scope: form.scope,
        target: form.target,
        effectiveTo: form.effectiveTo === "" ? null : form.effectiveTo,
        effectiveFrom: form.effectiveFrom,
        priority,
      },
    });
  }

  function confirmEndDate(): void {
    if (ending === null) return;
    if (!CIVIL_DATE.test(ending.date) || ending.date < ending.row.effective_from) {
      setErrors((prev) => ({ ...prev, endDate: t("timeAudit.assign.error.endDate") }));
      return;
    }
    setErrors((prev) => ({ ...prev, endDate: undefined }));
    endDate.reset();
    ask({
      action: "endDate",
      summary: t("timeAudit.assign.endDate.summary", {
        binding: summaryOf(ending.row),
        date: fmtCivilDate(ending.date),
      }),
      input: { id: ending.row.id, effectiveTo: ending.date },
    });
  }

  function runWrite(reason: string): void {
    if (pendingWrite === null) return;
    switch (pendingWrite.action) {
      case "create":
        create.save(pendingWrite.input, reason);
        break;
      case "endDate":
        endDate.save(pendingWrite.input, reason);
        break;
      case "archive":
        archive.save(pendingWrite.input, reason);
        break;
      case "restore":
        restore.save(pendingWrite.input, reason);
        break;
    }
  }

  // ── grid ─────────────────────────────────────────────────────────────────
  const columns: DataGridColumn<PolicyAssignment>[] = [
    {
      key: "assignment_kind",
      header: t("timeAudit.assign.col.kind"),
      width: "12rem",
      sortable: true,
      sortValue: (row) => row.assignment_kind,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="text-sm font-medium">{kindLabel(row.assignment_kind)}</span>
          {kindIsRead(row.assignment_kind) ? null : (
            <span className="text-xs text-warning">{t("timeAudit.assign.notRead")}</span>
          )}
        </span>
      ),
    },
    {
      key: "policy_id",
      header: t("timeAudit.assign.col.policy"),
      render: (row) => {
        const ref = policyText(row);
        return (
          <span className="flex flex-col leading-tight">
            <span className="text-sm">{ref.name}</span>
            {ref.code === null ? null : (
              <span className="font-mono text-xs text-muted-foreground">{ref.code}</span>
            )}
          </span>
        );
      },
    },
    {
      key: "scope",
      header: t("timeAudit.assign.col.scope"),
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="text-sm">{targetText(row)}</span>
          <span className="text-xs text-muted-foreground">
            {t("timeAudit.assign.scopeRank", {
              scope: scopeLabel(row.scope),
              rank: scopeRank(row.scope),
            })}
          </span>
        </span>
      ),
    },
    {
      key: "effective_from",
      header: t("timeAudit.assign.col.window"),
      width: "14rem",
      sortable: true,
      sortValue: (row) => row.effective_from,
      render: (row) => <span className="num text-sm">{windowLabel(row)}</span>,
    },
    {
      key: "state",
      header: t("timeAudit.assign.col.state"),
      width: "9rem",
      render: (row) => {
        const state = bindingState(row, asOf);
        return <StatusChip status={state} map={BINDING_CHIP} />;
      },
    },
    {
      key: "priority",
      header: t("timeAudit.assign.col.priority"),
      width: "6rem",
      align: "right",
      hideBelow: "md",
      render: (row) => <span className="num">{formatNumber(row.priority)}</span>,
    },
    {
      key: "reason",
      header: t("timeAudit.assign.col.reason"),
      hideBelow: "lg",
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="text-xs">{dash(row.reason)}</span>
          <span className="num text-xs text-muted-foreground">{fmtDateTime(row.created_at)}</span>
        </span>
      ),
    },
    {
      key: "actions",
      header: t("timeAudit.assign.col.actions"),
      width: "15rem",
      render: (row) =>
        row.deleted_at !== null ? (
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                restore.reset();
                ask({
                  action: "restore",
                  summary: t("timeAudit.assign.restore.summary", { binding: summaryOf(row) }),
                  input: { id: row.id },
                });
              }}
            >
              {t("timeAudit.assign.action.restore")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1">
            {row.effective_to === null ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setErrors((prev) => ({ ...prev, endDate: undefined }));
                  setEnding({ row, date: nowIstDate() });
                }}
              >
                {t("timeAudit.assign.action.endDate")}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                archive.reset();
                ask({
                  action: "archive",
                  summary: t("timeAudit.assign.archive.summary", { binding: summaryOf(row) }),
                  input: { id: row.id },
                });
              }}
            >
              {t("timeAudit.assign.action.archive")}
            </Button>
          </div>
        ),
    },
  ];

  const kindChoices: SelectOption[] = [
    { value: "", label: t("timeAudit.assign.filter.allKinds") },
    ...assignmentKindValues.map((kind) => ({ value: kind, label: kindLabel(kind) })),
  ];
  const scopeChoices: SelectOption[] = [
    { value: "", label: t("timeAudit.assign.filter.allScopes") },
    ...assignmentScopeValues.map((scope) => ({ value: scope, label: scopeLabel(scope) })),
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={Cog}
        title={t("timeAudit.assign.title")}
        subtitle={t("timeAudit.assign.subtitle")}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link to={`/admin/time/resolver?date=${asOf}`}>
                {t("timeAudit.assign.openResolver")}
              </Link>
            </Button>
            <Button
              onClick={() => {
                create.reset();
                setErrors({});
                setFormOpen((open) => !open);
              }}
            >
              <Plus className="mr-1.5 h-4 w-4" aria-hidden />
              {t("timeAudit.assign.action.new")}
            </Button>
          </div>
        }
      />

      <Notice tone="info" className="mb-4">
        <p>{t("timeAudit.assign.banner.body")}</p>
        <p className="mt-1">{t("timeAudit.assign.banner.precedence")}</p>
      </Notice>

      {unreadKinds.length > 0 ? (
        <Notice tone="warning" className="mb-4">
          {t("timeAudit.assign.banner.unread", {
            kinds: unreadKinds.map((kind) => kindLabel(kind)).join(", "),
          })}
        </Notice>
      ) : null}

      {/* ── Create form ──────────────────────────────────────────────────── */}
      {formOpen ? (
        <section className="mb-6 rounded-lg border bg-card p-4" aria-label={t("timeAudit.assign.form.title")}>
          <h2 className="font-display text-base font-semibold">{t("timeAudit.assign.form.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("timeAudit.assign.form.hint")}</p>

          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            <SelectField
              label={t("timeAudit.assign.field.kind")}
              hint={KIND_CONSUMER[form.kind]}
              value={form.kind}
              options={CREATABLE_KINDS.map((kind) => ({ value: kind, label: kindLabel(kind) }))}
              onChange={(value) => {
                setField("kind", value as AssignmentKind);
                setField("policyId", "");
              }}
              required
            />
            <SelectField
              label={t("timeAudit.assign.field.policy")}
              hint={t("timeAudit.assign.help.policy")}
              value={form.policyId}
              options={policyChoices}
              onChange={(value) => setField("policyId", value)}
              placeholder={t("timeAudit.assign.placeholder.policy")}
              error={errors.policyId ?? null}
              required
            />
            <SelectField
              label={t("timeAudit.assign.field.scope")}
              hint={t("timeAudit.assign.help.scope", {
                rank: SCOPE_RANK[form.scope],
              })}
              value={form.scope}
              options={assignmentScopeValues.map((scope) => ({
                value: scope,
                label: scopeLabel(scope),
              }))}
              onChange={(value) => {
                setField("scope", value as AssignmentScope);
                setField("target", "");
              }}
              required
            />
            <SelectField
              label={t("timeAudit.assign.field.target")}
              value={form.target}
              options={targetChoices}
              onChange={(value) => setField("target", value)}
              placeholder={t("timeAudit.assign.placeholder.target")}
              error={errors.target ?? null}
              required
            />
            <TextField
              label={t("timeAudit.assign.field.from")}
              hint={t("timeAudit.assign.help.from")}
              type="date"
              value={form.effectiveFrom}
              onChange={(value) => setField("effectiveFrom", value)}
              error={errors.effectiveFrom ?? null}
              required
            />
            <TextField
              label={t("timeAudit.assign.field.to")}
              hint={t("timeAudit.assign.help.to")}
              type="date"
              value={form.effectiveTo}
              onChange={(value) => setField("effectiveTo", value)}
              error={errors.effectiveTo ?? null}
            />
            <TextField
              label={t("timeAudit.assign.field.priority")}
              hint={t("timeAudit.assign.help.priority")}
              type="number"
              inputMode="numeric"
              value={form.priority}
              onChange={(value) => setField("priority", value)}
              error={errors.priority ?? null}
              min="0"
              max="999"
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button onClick={submitForm} disabled={writePending}>
              {t("timeAudit.assign.form.submit")}
            </Button>
            <Button variant="ghost" onClick={() => setFormOpen(false)} disabled={writePending}>
              {t("timeAudit.common.cancel")}
            </Button>
            <span className="text-xs text-muted-foreground">
              {t("timeAudit.assign.form.reasonNote")}
            </span>
          </div>
        </section>
      ) : null}

      {/* ── End-date panel ───────────────────────────────────────────────── */}
      {ending !== null ? (
        <section
          className="mb-6 rounded-lg border border-warning/40 bg-warning/5 p-4"
          aria-label={t("timeAudit.assign.endDate.title")}
        >
          <h2 className="flex items-center gap-2 font-display text-base font-semibold">
            <ShieldAlert className="h-4 w-4 text-warning" aria-hidden />
            {t("timeAudit.assign.endDate.title")}
          </h2>
          <p className="mt-1 text-sm">{summaryOf(ending.row)}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("timeAudit.assign.endDate.hint")}</p>
          <div className="mt-3 grid grid-cols-1 gap-4 md:max-w-sm">
            <TextField
              label={t("timeAudit.assign.endDate.field")}
              type="date"
              value={ending.date}
              min={ending.row.effective_from}
              onChange={(value) => setEnding({ row: ending.row, date: value })}
              error={errors.endDate ?? null}
              required
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={confirmEndDate} disabled={writePending}>
              {t("timeAudit.assign.endDate.submit")}
            </Button>
            <Button variant="ghost" onClick={() => setEnding(null)} disabled={writePending}>
              {t("timeAudit.common.cancel")}
            </Button>
          </div>
        </section>
      ) : null}

      {writeError !== null ? (
        <Notice tone="error" className="mb-4">
          {writeError}
        </Notice>
      ) : null}

      {/* ── Filters ──────────────────────────────────────────────────────── */}
      <section className="mb-4 grid grid-cols-1 gap-4 rounded-lg border bg-card p-3 sm:grid-cols-2 xl:grid-cols-4">
        <SelectField
          label={t("timeAudit.assign.filter.kind")}
          value={kindFilter ?? ""}
          options={kindChoices}
          onChange={(value) => patch({ kind: value })}
        />
        <SelectField
          label={t("timeAudit.assign.filter.scope")}
          value={scopeFilter ?? ""}
          options={scopeChoices}
          onChange={(value) => patch({ scope: value })}
        />
        <TextField
          label={t("timeAudit.assign.filter.asOf")}
          hint={t("timeAudit.assign.filter.asOfHint")}
          type="date"
          value={asOf}
          onChange={(value) => patch({ date: CIVIL_DATE.test(value) ? value : null })}
        />
        <SelectField
          label={t("timeAudit.assign.filter.view")}
          value={archivedView ? "archived" : "live"}
          options={[
            { value: "live", label: t("timeAudit.assign.filter.viewLive") },
            { value: "archived", label: t("timeAudit.assign.filter.viewArchived") },
          ]}
          onChange={(value) => patch({ view: value === "archived" ? "archived" : null })}
        />
      </section>

      <StateBoundary
        loading={list.isLoading}
        error={list.error ?? undefined}
        onRetry={() => void list.refetch()}
        partialError={labels.error ?? undefined}
        partialLabel={t("timeAudit.assign.partialLabel")}
        isEmpty={list.isSuccess && rows.length === 0}
        empty={
          <EmptyState
            icon={Cog}
            title={
              archivedView
                ? t("timeAudit.assign.empty.archivedTitle")
                : kindFilter !== null || scopeFilter !== null
                  ? t("timeAudit.assign.empty.filteredTitle")
                  : t("timeAudit.assign.empty.title")
            }
            hint={
              kindFilter !== null || scopeFilter !== null
                ? t("timeAudit.assign.empty.filteredHint")
                : t("timeAudit.assign.empty.hint")
            }
            action={
              kindFilter !== null || scopeFilter !== null || archivedView ? (
                <Button variant="outline" onClick={() => patch({ kind: null, scope: null, view: null })}>
                  {t("timeAudit.assign.empty.clear")}
                </Button>
              ) : (
                <Button onClick={() => setFormOpen(true)}>{t("timeAudit.assign.action.new")}</Button>
              )
            }
          />
        }
        skeletonRows={6}
      >
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiTile
            label={t("timeAudit.assign.kpi.onRecord")}
            value={liveCount.isPending ? t("app.loading") : formatNumber(liveCount.data ?? 0)}
            explainer={{
              formula: t("timeAudit.assign.kpi.onRecordFormula"),
              numbers: scopeNumbers,
            }}
          />
          <KpiTile
            label={t("timeAudit.assign.kpi.live", { date: fmtCivilDate(asOf) })}
            value={formatNumber(liveOnDate.length)}
            tone={liveOnDate.length === 0 ? "warn" : "success"}
            explainer={{
              formula: t("timeAudit.assign.kpi.liveFormula"),
              numbers: scopeNumbers,
            }}
          />
          <KpiTile
            label={t("timeAudit.assign.kpi.companyDefaults")}
            value={t("timeAudit.assign.kpi.ofKinds", {
              n: formatNumber(companyDefaults.size),
              total: formatNumber(assignmentKindValues.length),
            })}
            tone={companyDefaults.size === 0 ? "warn" : "neutral"}
            explainer={{
              formula: t("timeAudit.assign.kpi.companyDefaultsFormula"),
              numbers: scopeNumbers,
            }}
          />
          <KpiTile
            label={t("timeAudit.assign.kpi.archived")}
            value={archivedCount.isPending ? t("app.loading") : formatNumber(archivedCount.data ?? 0)}
            tone="neutral"
            explainer={{
              formula: t("timeAudit.assign.kpi.archivedFormula"),
              numbers: scopeNumbers,
            }}
          />
        </div>

        <DataGrid
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          pageSize={25}
          toolbar={
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="neutral">{t("timeAudit.assign.toolbar.count", { n: rows.length })}</Badge>
              <span>{t("timeAudit.assign.toolbar.hint")}</span>
            </div>
          }
        />

        <section className="mt-6 rounded-lg border bg-card p-4">
          <h2 className="flex items-center gap-2 font-display text-base font-semibold">
            <Sparkles className="h-4 w-4 text-muted-foreground" aria-hidden />
            {t("timeAudit.assign.consumers.title")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("timeAudit.assign.consumers.hint")}
          </p>
          <dl className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            {assignmentKindValues.map((kind) => (
              <div key={kind} className="rounded-md border bg-background p-3">
                <dt className="flex items-center gap-2 text-sm font-medium">
                  {kindLabel(kind)}
                  {kindIsRead(kind) ? null : (
                    <Badge variant="warning">{t("timeAudit.assign.notReadBadge")}</Badge>
                  )}
                </dt>
                <dd className="mt-1 text-xs text-muted-foreground">{KIND_CONSUMER[kind]}</dd>
              </div>
            ))}
          </dl>
        </section>
      </StateBoundary>

      <ReasonDialog
        open={promptOpen}
        title={
          pendingWrite === null
            ? t("timeAudit.assign.reason.title")
            : pendingWrite.action === "create"
              ? t("timeAudit.assign.reason.createTitle")
              : pendingWrite.action === "endDate"
                ? t("timeAudit.assign.reason.endDateTitle")
                : pendingWrite.action === "archive"
                  ? t("timeAudit.assign.reason.archiveTitle")
                  : t("timeAudit.assign.reason.restoreTitle")
        }
        description={pendingWrite?.summary}
        actorName={employee?.displayName ?? null}
        minLength={SENSITIVE_REASON_LENGTH}
        pending={writePending}
        errorMessage={writeError}
        onConfirm={runWrite}
        onCancel={() => {
          closePrompt();
          create.reset();
          endDate.reset();
          archive.reset();
          restore.reset();
        }}
      />

      <p className="mt-6 text-xs text-muted-foreground">{t("timeAudit.assign.footnote")}</p>
    </div>
  );
}
