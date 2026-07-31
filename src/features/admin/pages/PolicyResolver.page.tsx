/**
 * A-6.7 · /admin/time/resolver — "Why this policy?"
 *
 * A debugging surface, and therefore the one screen in the console that must
 * never guess. Everything it shows as an ANSWER comes from the deployed
 * functions, called with the same arguments the attendance engine uses:
 *
 *   * `public.resolve_policy(kind, employee, date)` — once per kind. Its
 *     precedence is narrowest scope first (employee 10 → company 80), then
 *     `priority` ascending, then the later `effective_from`
 *     (migration 014 lines 556–567).
 *   * `public.resolve_shift_for_date(employee, date)` — published roster slot →
 *     dated `shift_assignments` → `employees.shift_id` →
 *     `designations.default_shift_id` → the company's `G` shift
 *     (migration 014 lines 574–616).
 *   * `public.is_weekly_off(rule, date, employee)` — the single weekly-off
 *     decision, whose four rule kinds (fixed_weekdays, rotational, roster_driven,
 *     days_per_week) are implemented in plpgsql, not here.
 *
 * The CANDIDATE table underneath is the assignment register filtered to this
 * employee's own scope values and ranked by the ladder above — a presentation of
 * `policy_assignments`, not a second implementation of the resolver. Where the
 * two disagree (the server returned a policy no visible candidate carries, or
 * returned nothing while candidates exist) the screen says so in a warning
 * instead of quietly showing the plausible answer. That disagreement is exactly
 * the bug this page exists to catch.
 *
 * Three facts about the engine that are easy to get wrong and are stated on the
 * screen because an admin will otherwise infer the opposite:
 *  1. `employees.attendance_policy_id`, `weekly_off_rule_id` and
 *     `holiday_calendar_id` are NOT read by `f_recompute_attendance_day`. It goes
 *     through `resolve_policy` alone. Leave day-allocation
 *     (`build_leave_request_days`, migration 019 lines 773/782) DOES fall back to
 *     the employee columns, so the same employee can have one weekly-off answer
 *     for attendance and another for leave — and this page shows both.
 *  2. A published roster slot's `is_weekly_off` wins over the rule entirely
 *     (migration 018 line 297).
 *  3. When no attendance-policy binding resolves, the engine does not fail — it
 *     falls back to documented column defaults (migration 018 lines 245–263), so
 *     "nothing resolved" still produces numbers, which is why it is flagged.
 *
 * @route /admin/time/resolver
 */
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CalendarClock, CircleCheck, Cog, Search, ShieldAlert, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { AssignShiftCard } from "../components/AssignShiftCard";
import { shiftWindowLabel } from "../shiftWindow";
import { fmtCivilDate, fmtCivilDateWeekday, fmtCivilTime, fmtDurationHm, nowIstDate } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { AdminEmployee } from "../api/employees.api";
import { SelectField, TextField, type SelectOption } from "../components/Field";
import { Notice } from "../components/Notice";
import {
  coversDate,
  type AssignmentKind,
  type PolicyAssignment,
} from "../api/time-policy.api";
import {
  KIND_CONSUMER,
  employmentTypeLabel,
  kindIsRead,
  kindLabel,
  scopeLabel,
  scopeRank,
  windowLabel,
} from "../time-policy-display";
import {
  targetOf,
  useAssignmentCandidates,
  useAssignmentEmployeeOptions,
  useAssignmentLabels,
  useHolidaysOnDate,
  useIsWeeklyOff,
  usePayPeriodForDate,
  useResolvedPolicyRefs,
  useResolverEmployee,
  useServerResolution,
  useShiftDetail,
  useShiftRefs,
  useShiftTrace,
  type ShiftTrace,
} from "../hooks/useTimePolicy";

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The kinds worth resolving on this screen, in the order an admin reads them. */
const SHOWN_KINDS: readonly AssignmentKind[] = [
  "attendance_policy",
  "weekly_off_rule",
  "holiday_calendar",
  "shift",
  "pay_period",
  "leave_policy",
];

/** The employee attribute each scope compares against, in `resolve_policy`'s CASE. */
function employeeScopeValue(employee: AdminEmployee, scope: string): string | null {
  switch (scope) {
    case "employee":
      return employee.id;
    case "designation":
      return employee.designation_id;
    case "grade":
      return employee.grade_id;
    case "section":
      return employee.section_id;
    case "department":
      return employee.department_id;
    case "employment_type":
      return employee.employment_type;
    case "location":
      return employee.location_id;
    case "company":
      return employee.company_id;
    default:
      return null;
  }
}

/**
 * Does this binding apply to this employee at all? The same equality test
 * `resolve_policy`'s CASE performs, spelled once. A binding whose scope target is
 * NULL cannot match (the CHECK makes that impossible, but a NULL comparison in
 * SQL is false rather than an error, and so is this).
 */
function appliesTo(row: PolicyAssignment, employee: AdminEmployee): boolean {
  const target = targetOf(row);
  if (target === null) return false;
  return employeeScopeValue(employee, row.scope) === target;
}

/** `SCOPE_RANK` asc, then `priority` asc, then later `effective_from` — the ORDER BY. */
function byResolverOrder(a: PolicyAssignment, b: PolicyAssignment): number {
  const rankA = scopeRank(a.scope);
  const rankB = scopeRank(b.scope);
  if (rankA !== rankB) return rankA - rankB;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.effective_from < b.effective_from ? 1 : a.effective_from > b.effective_from ? -1 : 0;
}

/** One rung of `resolve_shift_for_date`. */
interface ShiftStep {
  readonly key: string;
  readonly label: string;
  readonly source: string;
  /** The shift this step offers, or null when the step is empty. */
  readonly shiftId: string | null;
  /** Extra line: the roster slot's own state, the assignment's window, … */
  readonly detail: string | null;
}

function shiftSteps(
  employee: AdminEmployee,
  trace: ShiftTrace,
  isoDate: string,
): readonly ShiftStep[] {
  const liveAssignment =
    trace.shiftAssignments.find((row) => coversDate(row, isoDate)) ?? null;
  return [
    {
      key: "roster",
      label: t("timeAudit.resolver.shift.step1"),
      source: t("timeAudit.resolver.shift.step1Source"),
      shiftId: trace.rosterSlot?.shift_id ?? null,
      detail:
        trace.rosterSlot === null
          ? t("timeAudit.resolver.shift.noSlot")
          : trace.rosterSlot.is_weekly_off
            ? t("timeAudit.resolver.shift.slotIsOff")
            : t("timeAudit.resolver.shift.slotPublished"),
    },
    {
      key: "assignment",
      label: t("timeAudit.resolver.shift.step2"),
      source: t("timeAudit.resolver.shift.step2Source"),
      shiftId: liveAssignment?.shift_id ?? null,
      detail:
        liveAssignment === null
          ? trace.shiftAssignments.length === 0
            ? t("timeAudit.resolver.shift.noAssignment")
            : t("timeAudit.resolver.shift.assignmentEnded")
          : windowLabel(liveAssignment),
    },
    {
      key: "employee",
      label: t("timeAudit.resolver.shift.step3"),
      source: t("timeAudit.resolver.shift.step3Source"),
      shiftId: employee.shift_id,
      detail: employee.shift_id === null ? t("timeAudit.resolver.shift.noColumn") : null,
    },
    {
      key: "designation",
      label: t("timeAudit.resolver.shift.step4"),
      source: t("timeAudit.resolver.shift.step4Source"),
      shiftId: trace.designation?.default_shift_id ?? null,
      detail:
        trace.designation === null
          ? t("timeAudit.resolver.shift.noDesignation")
          : trace.designation.name,
    },
    {
      key: "company",
      label: t("timeAudit.resolver.shift.step5"),
      source: t("timeAudit.resolver.shift.step5Source"),
      shiftId: trace.companyDefault?.id ?? null,
      detail:
        trace.companyDefault === null
          ? t("timeAudit.resolver.shift.noCompanyDefault")
          : trace.companyDefault.display_label,
    },
  ];
}

export default function PolicyResolverPage() {
  const [params, setParams] = useSearchParams();
  const employeeId = params.get("employee") ?? "";
  const dateParam = params.get("date");
  const isoDate = dateParam !== null && CIVIL_DATE.test(dateParam) ? dateParam : nowIstDate();

  function patch(next: Record<string, string | null>): void {
    const merged = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === "") merged.delete(key);
      else merged.set(key, value);
    }
    setParams(merged, { replace: true });
  }

  const people = useAssignmentEmployeeOptions(true);
  const employeeQuery = useResolverEmployee(employeeId === "" ? null : employeeId);
  const employee = employeeQuery.data ?? null;

  const resolution = useServerResolution(employeeId === "" ? null : employeeId, isoDate);
  const resolved = resolution.data;
  const refs = useResolvedPolicyRefs(resolved?.policies);

  const weeklyOffRuleId = resolved?.policies.weekly_off_rule ?? null;
  const weeklyOff = useIsWeeklyOff(weeklyOffRuleId, isoDate, employeeId === "" ? null : employeeId);

  const holidays = useHolidaysOnDate(resolved?.policies.holiday_calendar ?? null, isoDate);
  const payPeriod = usePayPeriodForDate(isoDate);

  const trace = useShiftTrace(employee, isoDate);
  const shiftDetail = useShiftDetail(resolved?.shiftId ?? null);

  const candidatesQuery = useAssignmentCandidates(isoDate);
  const allCandidates = useMemo(() => candidatesQuery.data ?? [], [candidatesQuery.data]);

  /** Only the bindings whose scope target equals one of THIS employee's values. */
  const candidates = useMemo(() => {
    if (employee === null) return [];
    return allCandidates.filter((row) => appliesTo(row, employee)).sort(byResolverOrder);
  }, [allCandidates, employee]);

  const labels = useAssignmentLabels(candidates);

  const steps = useMemo(
    () => (employee === null || trace.data === undefined ? [] : shiftSteps(employee, trace.data, isoDate)),
    [employee, trace.data, isoDate],
  );
  const answeringStep = steps.find((step) => step.shiftId !== null) ?? null;
  const shiftRefs = useShiftRefs(
    steps.flatMap((step) => (step.shiftId === null ? [] : [step.shiftId])),
  );

  /** The candidate the ladder puts first for one kind, and the server's answer. */
  const perKind = useMemo(() => {
    return SHOWN_KINDS.map((kind) => {
      const kindCandidates = candidates.filter((row) => row.assignment_kind === kind);
      const resolvedId = resolved?.policies[kind] ?? null;
      const winner = kindCandidates.find((row) => row.policy_id === resolvedId) ?? null;
      return { kind, candidates: kindCandidates, resolvedId, winner };
    });
  }, [candidates, resolved]);

  /**
   * The honest disagreement checks. Either would mean the candidate list on
   * screen is not the set the server ranked — a stale read, a scope column this
   * page does not know about, or an RLS-hidden row.
   */
  const mismatches = perKind.filter(
    (entry) =>
      (entry.resolvedId !== null && entry.winner === null) ||
      (entry.resolvedId === null && entry.candidates.length > 0),
  );
  const shiftMismatch =
    resolved !== undefined &&
    trace.data !== undefined &&
    answeringStep !== null &&
    resolved.shiftId !== null &&
    answeringStep.shiftId !== resolved.shiftId;

  const peopleChoices: SelectOption[] = (people.data ?? []).map((row) => ({
    value: row.id,
    label: t("timeAudit.common.personOption", {
      name: row.display_name,
      code: row.employee_code,
    }),
  }));

  function policyName(policyId: string | null, kind: AssignmentKind): string {
    if (policyId === null) return t("timeAudit.resolver.nothingResolved");
    const ref = refs.data?.get(policyId);
    if (ref !== undefined) return ref.name;
    return kind === "leave_policy"
      ? t("timeAudit.resolver.noLeaveTable")
      : t("timeAudit.resolver.unnamedPolicy");
  }

  const candidateColumns: DataGridColumn<PolicyAssignment>[] = [
    {
      key: "rank",
      header: t("timeAudit.resolver.col.rank"),
      width: "7rem",
      align: "right",
      render: (row) => (
        <span className="num">{formatNumber(scopeRank(row.scope))}</span>
      ),
    },
    {
      key: "assignment_kind",
      header: t("timeAudit.resolver.col.kind"),
      width: "12rem",
      render: (row) => <span className="text-sm">{kindLabel(row.assignment_kind)}</span>,
    },
    {
      key: "scope",
      header: t("timeAudit.resolver.col.scope"),
      render: (row) => {
        const target = targetOf(row);
        const name =
          target === null
            ? dash(null)
            : row.scope === "employment_type"
              ? employmentTypeLabel(target)
              : row.scope === "employee"
                ? (labels.data?.employees.get(target)?.display_name ??
                  t("timeAudit.assign.targetUnknown"))
                : (labels.data?.scopes.get(target)?.name ?? t("timeAudit.assign.targetUnknown"));
        return (
          <span className="flex flex-col leading-tight">
            <span className="text-sm">{name}</span>
            <span className="text-xs text-muted-foreground">{scopeLabel(row.scope)}</span>
          </span>
        );
      },
    },
    {
      key: "policy_id",
      header: t("timeAudit.resolver.col.policy"),
      render: (row) => {
        const ref = labels.data?.policies.get(row.policy_id);
        return (
          <span className="flex flex-col leading-tight">
            <span className="text-sm">{ref?.name ?? t("timeAudit.assign.policyUnknown")}</span>
            {ref === undefined ? null : (
              <span className="font-mono text-xs text-muted-foreground">{ref.code}</span>
            )}
          </span>
        );
      },
    },
    {
      key: "priority",
      header: t("timeAudit.resolver.col.priority"),
      width: "6rem",
      align: "right",
      hideBelow: "md",
      render: (row) => <span className="num">{formatNumber(row.priority)}</span>,
    },
    {
      key: "effective_from",
      header: t("timeAudit.resolver.col.window"),
      width: "14rem",
      hideBelow: "md",
      render: (row) => <span className="num text-sm">{windowLabel(row)}</span>,
    },
    {
      key: "verdict",
      header: t("timeAudit.resolver.col.verdict"),
      width: "11rem",
      render: (row) => {
        const entry = perKind.find((item) => item.kind === row.assignment_kind);
        if (entry?.winner?.id === row.id) {
          return <Badge variant="success">{t("timeAudit.resolver.winner")}</Badge>;
        }
        return (
          <span className="text-xs text-muted-foreground">{t("timeAudit.resolver.shadowed")}</span>
        );
      },
    },
  ];

  const ready = employeeId !== "" && employee !== null && resolved !== undefined;

  return (
    <div className="container py-6">
      <PageHeader
        icon={Cog}
        title={t("timeAudit.resolver.title")}
        subtitle={t("timeAudit.resolver.subtitle")}
        actions={
          <Button variant="outline" asChild>
            <Link to={`/admin/time/assignments?date=${isoDate}`}>
              {t("timeAudit.resolver.openAssignments")}
            </Link>
          </Button>
        }
      />

      <Notice tone="info" className="mb-4">
        <p>{t("timeAudit.resolver.banner.body")}</p>
        <p className="mt-1">{t("timeAudit.resolver.banner.precedence")}</p>
      </Notice>

      <section className="mb-5 grid grid-cols-1 gap-4 rounded-lg border bg-card p-4 md:grid-cols-2 xl:grid-cols-3">
        <SelectField
          label={t("timeAudit.resolver.field.employee")}
          hint={t("timeAudit.resolver.help.employee")}
          value={employeeId}
          options={peopleChoices}
          onChange={(value) => patch({ employee: value })}
          placeholder={t("timeAudit.resolver.placeholder.employee")}
          required
        />
        <TextField
          label={t("timeAudit.resolver.field.date")}
          hint={t("timeAudit.resolver.help.date")}
          type="date"
          value={isoDate}
          onChange={(value) => patch({ date: CIVIL_DATE.test(value) ? value : null })}
          required
        />
        <div className="flex items-end">
          <p className="text-sm text-muted-foreground">
            {t("timeAudit.resolver.dateEcho", { date: fmtCivilDateWeekday(isoDate) })}
          </p>
        </div>
      </section>

      {employeeId === "" ? (
        <EmptyState
          icon={Search}
          title={t("timeAudit.resolver.pick.title")}
          hint={t("timeAudit.resolver.pick.hint")}
        />
      ) : (
        <StateBoundary
          loading={employeeQuery.isLoading || resolution.isLoading}
          error={employeeQuery.error ?? resolution.error ?? undefined}
          onRetry={() => {
            void employeeQuery.refetch();
            void resolution.refetch();
          }}
          partialError={candidatesQuery.error ?? refs.error ?? labels.error ?? undefined}
          partialLabel={t("timeAudit.resolver.partialLabel")}
          isEmpty={employeeQuery.isSuccess && employee === null}
          empty={
            <EmptyState
              icon={UserRound}
              title={t("timeAudit.resolver.noEmployee.title")}
              hint={t("timeAudit.resolver.noEmployee.hint")}
            />
          }
          skeletonRows={6}
        >
          {employee === null ? null : (
            <>
              {/* ── Who, and with which scope values ─────────────────────── */}
              <section className="mb-5 rounded-lg border bg-card p-4">
                <h2 className="font-display text-base font-semibold">
                  {t("timeAudit.resolver.person.title")}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("timeAudit.resolver.person.hint")}
                </p>
                <dl className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                  <ScopeFact label={t("timeAudit.scope.employee")} value={`${employee.display_name} · ${employee.employee_code}`} />
                  <ScopeFact label={t("timeAudit.scope.department")} value={dash(employee.department_name)} />
                  <ScopeFact label={t("timeAudit.scope.section")} value={dash(employee.section_name)} />
                  <ScopeFact label={t("timeAudit.scope.designation")} value={dash(employee.designation_name)} />
                  <ScopeFact label={t("timeAudit.scope.grade")} value={dash(employee.grade_name)} />
                  <ScopeFact label={t("timeAudit.scope.location")} value={dash(employee.location_name)} />
                  <ScopeFact
                    label={t("timeAudit.scope.employment_type")}
                    value={employmentTypeLabel(employee.employment_type)}
                  />
                  <ScopeFact label={t("timeAudit.scope.company")} value={dash(employee.company_name)} />
                </dl>
                {employee.exclude_from_attendance ? (
                  <Notice tone="warning" className="mt-3">
                    {t("timeAudit.resolver.person.excluded")}
                  </Notice>
                ) : null}
              </section>

              {mismatches.length > 0 || shiftMismatch ? (
                <div
                  className="mb-5 flex items-start gap-3 rounded-lg border-2 border-destructive bg-destructive/5 p-4"
                  role="alert"
                >
                  <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden />
                  <div>
                    <p className="font-display font-semibold text-destructive">
                      {t("timeAudit.resolver.mismatch.title")}
                    </p>
                    <p className="mt-1 text-sm">{t("timeAudit.resolver.mismatch.body")}</p>
                    <ul className="mt-2 list-inside list-disc text-sm">
                      {mismatches.map((entry) => (
                        <li key={entry.kind}>
                          {entry.resolvedId === null
                            ? t("timeAudit.resolver.mismatch.nothingWon", {
                                kind: kindLabel(entry.kind),
                                n: entry.candidates.length,
                              })
                            : t("timeAudit.resolver.mismatch.unlistedWinner", {
                                kind: kindLabel(entry.kind),
                              })}
                        </li>
                      ))}
                      {shiftMismatch ? <li>{t("timeAudit.resolver.mismatch.shift")}</li> : null}
                    </ul>
                  </div>
                </div>
              ) : null}

              {/* ── What the server resolved, per kind ───────────────────── */}
              <h2 className="mb-2 font-display text-lg font-semibold">
                {t("timeAudit.resolver.resolved.title")}
              </h2>
              <p className="mb-3 text-sm text-muted-foreground">
                {t("timeAudit.resolver.resolved.hint")}
              </p>
              <div className="mb-6 grid grid-cols-1 gap-3 lg:grid-cols-2">
                {perKind.map((entry) => (
                  <article key={entry.kind} className="rounded-lg border bg-card p-4">
                    <header className="flex flex-wrap items-center gap-2">
                      <h3 className="font-display text-sm font-semibold">
                        {kindLabel(entry.kind)}
                      </h3>
                      {kindIsRead(entry.kind) ? null : (
                        <Badge variant="warning">{t("timeAudit.assign.notReadBadge")}</Badge>
                      )}
                      {entry.resolvedId === null ? (
                        <Badge variant="neutral">{t("timeAudit.resolver.nothingResolved")}</Badge>
                      ) : (
                        <Badge variant="success">{t("timeAudit.resolver.resolvedBadge")}</Badge>
                      )}
                    </header>
                    <p className="mt-2 text-sm font-medium">
                      {entry.kind === "shift"
                        ? (shiftDetail.data?.display_label ??
                          policyName(resolved?.shiftId ?? null, "shift"))
                        : policyName(entry.resolvedId, entry.kind)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {entry.winner === null
                        ? t("timeAudit.resolver.noWinningBinding")
                        : t("timeAudit.resolver.wonBecause", {
                            scope: scopeLabel(entry.winner.scope),
                            rank: scopeRank(entry.winner.scope),
                            priority: entry.winner.priority,
                            from: fmtCivilDate(entry.winner.effective_from),
                            n: entry.candidates.length,
                          })}
                    </p>
                    <p className="mt-2 border-t pt-2 text-xs text-muted-foreground">
                      {KIND_CONSUMER[entry.kind]}
                    </p>
                  </article>
                ))}
              </div>

              {/* ── The shift ladder ─────────────────────────────────────── */}
              <h2 className="mb-2 font-display text-lg font-semibold">
                {t("timeAudit.resolver.shift.title")}
              </h2>
              <p className="mb-3 text-sm text-muted-foreground">
                {t("timeAudit.resolver.shift.hint")}
              </p>
              <StateBoundary
                loading={trace.isLoading}
                error={trace.error ?? undefined}
                onRetry={() => void trace.refetch()}
                skeletonRows={3}
              >
                <ol className="mb-6 space-y-2">
                  {steps.map((step, index) => {
                    const answered = answeringStep?.key === step.key;
                    const skipped = answeringStep !== null && !answered && step.shiftId !== null;
                    const ref = step.shiftId === null ? undefined : shiftRefs.data?.get(step.shiftId);
                    return (
                      <li
                        key={step.key}
                        className={
                          answered
                            ? "rounded-lg border-2 border-success/50 bg-success/5 p-3"
                            : "rounded-lg border bg-card p-3"
                        }
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="num text-xs text-muted-foreground">
                            {t("timeAudit.resolver.shift.stepNumber", { n: index + 1 })}
                          </span>
                          <span className="text-sm font-medium">{step.label}</span>
                          {answered ? (
                            <Badge variant="success">{t("timeAudit.resolver.shift.answered")}</Badge>
                          ) : step.shiftId === null ? (
                            <Badge variant="neutral">{t("timeAudit.resolver.shift.empty")}</Badge>
                          ) : skipped ? (
                            <Badge variant="neutral">{t("timeAudit.resolver.shift.notReached")}</Badge>
                          ) : null}
                        </div>
                        <p className="mt-1 text-sm">
                          {step.shiftId === null
                            ? t("timeAudit.resolver.shift.noValue")
                            : (ref?.name ?? t("timeAudit.resolver.shift.unnamed"))}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {step.source}
                          {step.detail === null ? "" : ` · ${step.detail}`}
                        </p>
                      </li>
                    );
                  })}
                </ol>
              </StateBoundary>

              {shiftDetail.data !== null && shiftDetail.data !== undefined ? (
                <section className="mb-6 rounded-lg border bg-card p-4">
                  <h3 className="font-display text-sm font-semibold">
                    {t("timeAudit.resolver.shift.detailTitle")}
                  </h3>
                  <dl className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                    <ScopeFact
                      label={t("timeAudit.resolver.shift.window")}
                      value={`${fmtCivilTime(shiftDetail.data.start_time)} – ${fmtCivilTime(shiftDetail.data.end_time)}`}
                    />
                    <ScopeFact
                      label={t("timeAudit.resolver.shift.duration")}
                      value={fmtDurationHm(shiftDetail.data.duration_minutes)}
                    />
                    <ScopeFact
                      label={t("timeAudit.resolver.shift.grace")}
                      value={fmtDurationHm(shiftDetail.data.grace_in_minutes)}
                    />
                    <ScopeFact
                      label={t("timeAudit.resolver.shift.night")}
                      value={
                        shiftDetail.data.night_shift
                          ? t("timeAudit.common.yes")
                          : t("timeAudit.common.no")
                      }
                    />
                  </dl>
                </section>
              ) : null}

              {/*
                The write, directly under the read. The trace above says which of the
                five steps answered; this changes step 2 for this one person, and the
                card warns when a published roster slot will outrank it anyway.
              */}
              <AssignShiftCard
                employeeId={employee.id}
                employeeName={employee.display_name}
                currentShiftLabel={shiftWindowLabel(
                  shiftDetail.data?.name ?? null,
                  shiftDetail.data?.start_time ?? null,
                  shiftDetail.data?.end_time ?? null,
                )}
                rosterSlotWins={trace.data?.rosterSlot != null}
              />

              {/* ── Weekly off, holiday, period ──────────────────────────── */}
              <h2 className="mb-2 font-display text-lg font-semibold">
                {t("timeAudit.resolver.day.title")}
              </h2>
              <div className="mb-6 grid grid-cols-1 gap-3 lg:grid-cols-3">
                <article className="rounded-lg border bg-card p-4">
                  <h3 className="font-display text-sm font-semibold">
                    {t("timeAudit.resolver.day.weeklyOff")}
                  </h3>
                  <p className="mt-2 text-sm font-medium">
                    {trace.data?.rosterSlot?.is_weekly_off === true
                      ? t("timeAudit.resolver.day.offByRoster")
                      : weeklyOffRuleId === null
                        ? t("timeAudit.resolver.day.noRule")
                        : weeklyOff.data === true
                          ? t("timeAudit.resolver.day.offByRule")
                          : weeklyOff.data === false
                            ? t("timeAudit.resolver.day.working")
                            : t("app.loading")}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("timeAudit.resolver.day.weeklyOffHow")}
                  </p>
                  {weeklyOffRuleId === null ? null : (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("timeAudit.resolver.day.ruleName", {
                        name: policyName(weeklyOffRuleId, "weekly_off_rule"),
                      })}
                    </p>
                  )}
                </article>

                <article className="rounded-lg border bg-card p-4">
                  <h3 className="font-display text-sm font-semibold">
                    {t("timeAudit.resolver.day.holiday")}
                  </h3>
                  <p className="mt-2 text-sm font-medium">
                    {resolved?.policies.holiday_calendar === null
                      ? t("timeAudit.resolver.day.noCalendar")
                      : (holidays.data ?? []).length === 0
                        ? t("timeAudit.resolver.day.notAHoliday")
                        : (holidays.data ?? [])
                            .map((holiday) => holiday.name)
                            .join(", ")}
                  </p>
                  {(holidays.data ?? []).map((holiday) => (
                    <p key={holiday.id} className="mt-1 text-xs text-muted-foreground">
                      {t("timeAudit.resolver.day.holidayDetail", {
                        type: holiday.holiday_type,
                        paid: holiday.is_paid ? t("timeAudit.common.yes") : t("timeAudit.common.no"),
                        scope:
                          holiday.applies_to_department_ids === null
                            ? t("timeAudit.resolver.day.allDepartments")
                            : t("timeAudit.resolver.day.someDepartments"),
                      })}
                    </p>
                  ))}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("timeAudit.resolver.day.holidayHow")}
                  </p>
                </article>

                <article className="rounded-lg border bg-card p-4">
                  <h3 className="font-display text-sm font-semibold">
                    {t("timeAudit.resolver.day.period")}
                  </h3>
                  <p className="mt-2 text-sm font-medium">
                    {payPeriod.data === null || payPeriod.data === undefined
                      ? t("timeAudit.resolver.day.noPeriod")
                      : payPeriod.data.name}
                  </p>
                  {payPeriod.data === null || payPeriod.data === undefined ? null : (
                    <>
                      <p className="mt-1 num text-xs text-muted-foreground">
                        {t("timeAudit.resolver.day.periodWindow", {
                          from: fmtCivilDate(payPeriod.data.start_date),
                          to: fmtCivilDate(payPeriod.data.end_date),
                          cutoff: fmtCivilDate(payPeriod.data.attendance_cutoff_date),
                        })}
                      </p>
                      <div className="mt-1 text-xs">
                        {payPeriod.data.attendance_locked_at === null ? (
                          <Badge variant="success">{t("timeAudit.resolver.day.periodOpen")}</Badge>
                        ) : (
                          <Badge variant="warning">{t("timeAudit.resolver.day.periodLocked")}</Badge>
                        )}
                      </div>
                    </>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("timeAudit.resolver.day.periodHow")}
                  </p>
                </article>
              </div>

              {/* ── Candidates ──────────────────────────────────────────── */}
              <h2 className="mb-2 font-display text-lg font-semibold">
                {t("timeAudit.resolver.candidates.title")}
              </h2>
              <p className="mb-3 text-sm text-muted-foreground">
                {t("timeAudit.resolver.candidates.hint", {
                  date: fmtCivilDate(isoDate),
                  n: formatNumber(allCandidates.length),
                })}
              </p>
              <DataGrid
                columns={candidateColumns}
                rows={candidates}
                rowKey={(row) => row.id}
                pageSize={25}
                emptyState={
                  <EmptyState
                    icon={CalendarClock}
                    title={t("timeAudit.resolver.candidates.empty.title")}
                    hint={t("timeAudit.resolver.candidates.empty.hint")}
                    action={
                      <Button variant="outline" asChild>
                        <Link to="/admin/time/assignments">
                          {t("timeAudit.resolver.openAssignments")}
                        </Link>
                      </Button>
                    }
                  />
                }
              />

              {ready && mismatches.length === 0 && !shiftMismatch ? (
                <div className="mt-4 flex items-center gap-2 rounded-md border border-success/40 bg-success/5 px-3 py-2 text-sm">
                  <CircleCheck className="h-4 w-4 shrink-0 text-success" aria-hidden />
                  <span>{t("timeAudit.resolver.agree")}</span>
                </div>
              ) : null}

              <section className="mt-6 rounded-lg border bg-card p-4">
                <h2 className="font-display text-base font-semibold">
                  {t("timeAudit.resolver.notes.title")}
                </h2>
                <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
                  <li>{t("timeAudit.resolver.notes.engineIgnoresColumns")}</li>
                  <li>{t("timeAudit.resolver.notes.leaveFallback")}</li>
                  <li>{t("timeAudit.resolver.notes.rosterWins")}</li>
                  <li>{t("timeAudit.resolver.notes.policyDefaults")}</li>
                </ul>
                <dl className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                  <ScopeFact
                    label={t("timeAudit.resolver.notes.colAttendance")}
                    value={
                      employee.attendance_policy_code ??
                      (employee.attendance_policy_id === null
                        ? t("timeAudit.common.notSet")
                        : t("timeAudit.common.set"))
                    }
                  />
                  <ScopeFact
                    label={t("timeAudit.resolver.notes.colWeeklyOff")}
                    value={
                      employee.weekly_off_rule_id === null
                        ? t("timeAudit.common.notSet")
                        : t("timeAudit.common.set")
                    }
                  />
                  <ScopeFact
                    label={t("timeAudit.resolver.notes.colCalendar")}
                    value={
                      employee.holiday_calendar_id === null
                        ? t("timeAudit.common.notSet")
                        : t("timeAudit.common.set")
                    }
                  />
                  <ScopeFact
                    label={t("timeAudit.resolver.notes.colShift")}
                    value={
                      employee.shift_code ??
                      (employee.shift_id === null
                        ? t("timeAudit.common.notSet")
                        : t("timeAudit.common.set"))
                    }
                  />
                </dl>
              </section>
            </>
          )}
        </StateBoundary>
      )}

      <p className="mt-6 text-xs text-muted-foreground">{t("timeAudit.resolver.footnote")}</p>
    </div>
  );
}

/** One label/value pair in a facts grid. */
function ScopeFact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm font-medium" title={value}>
        {value}
      </dd>
    </div>
  );
}
