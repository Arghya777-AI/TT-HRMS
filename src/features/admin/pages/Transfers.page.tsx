/**
 * §2 · /admin/people/transfers — Transfers & Promotions.
 *
 * RECON FIRST, and it changes the screen. Migration 011 deploys ONE trigger
 * between the two halves of this page, and it runs in one direction only:
 *
 *   `trg_ele__status_projection` — AFTER INSERT ON employee_lifecycle_events →
 *   UPDATE public.employees (employment_status, confirmed_on, resignation_date,
 *   last_working_day, exit_type).
 *
 * For the four movement event types (`promoted`, `transferred`,
 * `department_changed`, `manager_changed`) that trigger maps the status to NULL,
 * i.e. a movement deliberately changes NO status. And nothing runs the other way:
 * updating `employees.department_id` or `designation_id` appends NO lifecycle
 * event, and there is no deployed function or RPC that records the pair
 * atomically. So this screen is honest about being two things:
 *
 *  1. THE REGISTER is the append-only event stream itself
 *     (`employee_lifecycle_events`, admin-scoped by its own RLS policy), with the
 *     event's `from_values` → `to_values` bag resolved against the org masters.
 *     Ids are joined to names; nothing is derived.
 *  2. RECORDING A MOVEMENT is the employee master's own audited UPDATE
 *     (`updateEmployee`, migration 051's granted column set), which writes one
 *     `audit_log` row per changed field carrying the typed reason, and is visible
 *     immediately on that person's history. It does NOT append an event, and the
 *     screen says so rather than implying the register will grow a row.
 *
 * The master has no effective-date column for a movement either, so a movement
 * applies from the moment it is saved; the page states that instead of offering a
 * future date that would be silently dropped.
 *
 * @route /admin/people/transfers
 */
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight, History, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { dash, formatNumber } from "@/lib/format";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { PERIOD_PARAM_KEYS } from "@/lib/period";
import { t } from "@/shared/i18n/en";
import { PeriodBar } from "../components/PeriodBar";
import { periodLabel } from "../analyticsFilterBar";
import { useAnalyticsFilters } from "../hooks/useAnalyticsFilters";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { ReasonActionButton } from "../components/ReasonActionButton";
import { SelectField } from "../components/Field";
import { useEmployeeLabels, useEmployeeOptions } from "../hooks/useEmployeeLabels";
import { useRefOptions } from "../hooks/useMasters";
import { useAdminEmployee } from "../hooks/usePeople";
import {
  useLifecycleEventCount,
  useLifecycleEvents,
  useLifecycleEmployeeUpdate,
} from "../hooks/usePeopleLifecycle";
import {
  LIFECYCLE_EVENT_LABELS,
  LIFECYCLE_LIST_LIMIT,
  MOVEMENT_EVENT_TYPES,
  movementPatch,
  type LifecycleEvent,
  type LifecycleEventFilters,
  type LifecycleEventType,
  type MovementInput,
} from "../api/lifecycle.api";

const EVENT_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  promoted: { label: LIFECYCLE_EVENT_LABELS.promoted, tone: "success" },
  transferred: { label: LIFECYCLE_EVENT_LABELS.transferred, tone: "info" },
  department_changed: { label: LIFECYCLE_EVENT_LABELS.department_changed, tone: "info" },
  manager_changed: { label: LIFECYCLE_EVENT_LABELS.manager_changed, tone: "neutral" },
};

/** The jsonb keys a movement bag actually carries, in the order HR reads them. */
const VALUE_KEYS: readonly { key: string; label: string; ref: RefKind }[] = [
  { key: "department_id", label: t("admin.transfers.field.department"), ref: "departments" },
  { key: "section_id", label: t("admin.transfers.field.section"), ref: "sections" },
  { key: "designation_id", label: t("admin.transfers.field.designation"), ref: "designations" },
  { key: "grade_id", label: t("admin.transfers.field.grade"), ref: "grades" },
  { key: "location_id", label: t("admin.transfers.field.location"), ref: "locations" },
  { key: "cost_centre_id", label: t("admin.transfers.field.costCentre"), ref: "costCentres" },
  { key: "reporting_manager_id", label: t("admin.transfers.field.manager"), ref: "employees" },
];

type RefKind =
  | "departments"
  | "sections"
  | "designations"
  | "grades"
  | "locations"
  | "costCentres"
  | "employees";

function isMovementType(v: string | null): v is LifecycleEventType {
  return v !== null && MOVEMENT_EVENT_TYPES.some((m) => m === v);
}

export default function TransfersPage() {
  const [params, setParams] = useSearchParams();

  /*
    THE PERIOD IS SHARED with the analytics dashboard, read from the same url
    parameters, so a period chosen there survives the click into this screen.
    Named `analytics` so it cannot be confused with this page's own filters.
  */
  const { filters: analytics } = useAnalyticsFilters();
  const typeParam = params.get("type");
  const eventType: LifecycleEventType | "" = isMovementType(typeParam) ? typeParam : "";
  const employeeId = params.get("employee") ?? "";
  const includeReversed = params.get("reversed") === "true";

  const range = useMemo(
    () => ({ from: analytics.period.from, to: analytics.period.to }),
    [analytics.period.from, analytics.period.to],
  );

  const labels = useEmployeeLabels();
  const employeeOptions = useEmployeeOptions(labels.data);
  const departments = useRefOptions("departments");
  const sections = useRefOptions("sections");
  const designations = useRefOptions("designations");
  const grades = useRefOptions("grades");
  const locations = useRefOptions("locations");
  const costCentres = useRefOptions("costCentres");

  /** id → name for every master a movement bag can point at. */
  const resolvers = useMemo<Readonly<Record<RefKind, ReadonlyMap<string, string>>>>(() => {
    const build = (rows: readonly { id: string; name: string }[] | undefined) => {
      const map = new Map<string, string>();
      for (const row of rows ?? []) map.set(row.id, row.name);
      return map;
    };
    const people = new Map<string, string>();
    for (const label of labels.data?.values() ?? []) people.set(label.id, label.name);
    return {
      departments: build(departments.data),
      sections: build(sections.data),
      designations: build(designations.data),
      grades: build(grades.data),
      locations: build(locations.data),
      costCentres: build(costCentres.data),
      employees: people,
    };
  }, [
    departments.data,
    sections.data,
    designations.data,
    grades.data,
    locations.data,
    costCentres.data,
    labels.data,
  ]);

  const filters = useMemo<LifecycleEventFilters>(
    () => ({
      from: range.from,
      to: range.to,
      eventTypes: eventType === "" ? MOVEMENT_EVENT_TYPES : [eventType],
      ...(employeeId !== "" ? { employeeIds: [employeeId] } : {}),
      ...(includeReversed ? { includeReversed: true } : {}),
    }),
    [range, eventType, employeeId, includeReversed],
  );

  const events = useLifecycleEvents(filters);
  const total = useLifecycleEventCount(filters);
  const rows = events.data ?? [];

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: true });
  }


  const columns: DataGridColumn<LifecycleEvent>[] = [
    {
      key: "effective_date",
      header: t("admin.transfers.col.effective"),
      width: "10rem",
      sortable: true,
      render: (r) => <span className="num">{fmtCivilDate(r.effective_date)}</span>,
    },
    {
      key: "employee_id",
      header: t("admin.transfers.col.employee"),
      width: "16rem",
      render: (r) => {
        const label = labels.data?.get(r.employee_id);
        return label === undefined ? (
          <span className="text-sm text-muted-foreground">{t("admin.transfers.unknownPerson")}</span>
        ) : (
          <PersonCell name={label.name} code={label.code} secondary={label.department} />
        );
      },
    },
    {
      key: "event_type",
      header: t("admin.transfers.col.event"),
      width: "11rem",
      render: (r) => <StatusChip status={r.event_type} map={EVENT_CHIP} />,
    },
    {
      key: "to_values",
      header: t("admin.transfers.col.moved"),
      render: (r) => <MovedCell event={r} resolvers={resolvers} />,
    },
    {
      key: "reason",
      header: t("admin.transfers.col.reason"),
      hideBelow: "lg",
      render: (r) => <span className="text-sm">{r.reason}</span>,
    },
    {
      key: "recorded_at",
      header: t("admin.transfers.col.recorded"),
      width: "12rem",
      align: "right",
      hideBelow: "md",
      render: (r) => (
        <span className="num text-xs">
          {fmtDateTime(r.recorded_at)}
          {r.is_reversed ? (
            <span className="ml-1 text-warning">{t("admin.transfers.reversed")}</span>
          ) : null}
        </span>
      ),
    },
  ];

  const capped = total.isSuccess && total.data > rows.length;

  return (
    <div className="container py-6">
      <PageHeader
        icon={Workflow}
        title={t("admin.transfers.title")}
        subtitle={t("admin.transfers.subtitle", { month: periodLabel(analytics.period) })}
      />

      <PeriodBar className="mb-4" />

      <div className="mt-4">
        <Notice tone="info">{t("admin.transfers.triggerNotice")}</Notice>
      </div>

      <RecordMovement
        employeeOptions={employeeOptions}
        departments={departments.data ?? []}
        sections={sections.data ?? []}
        designations={designations.data ?? []}
        grades={grades.data ?? []}
        codeOf={(id) => labels.data?.get(id)?.code ?? ""}
      />

      <h2 className="mt-6 font-display text-lg font-semibold">{t("admin.transfers.register")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {total.isSuccess
          ? t("admin.transfers.registerCount", {
              n: formatNumber(total.data),
              month: periodLabel(analytics.period),
            })
          : t("admin.transfers.registerCountUnknown")}
      </p>

      <div className="mt-3 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <SelectField
          label={t("admin.transfers.filter.event")}
          value={eventType}
          placeholder={t("admin.transfers.filter.anyEvent")}
          options={MOVEMENT_EVENT_TYPES.map((v) => ({ value: v, label: LIFECYCLE_EVENT_LABELS[v] }))}
          onChange={(v) => setParam("type", v)}
        />
        <SelectField
          label={t("admin.transfers.filter.employee")}
          value={employeeId}
          placeholder={t("admin.transfers.filter.anyEmployee")}
          options={employeeOptions}
          onChange={(v) => setParam("employee", v)}
        />
        <div className="flex items-end gap-2">
          <Button
            type="button"
            variant={includeReversed ? "default" : "outline"}
            aria-pressed={includeReversed}
            onClick={() => setParam("reversed", includeReversed ? "" : "true")}
          >
            {t("admin.transfers.filter.includeReversed")}
          </Button>
        </div>
        <div className="flex items-end">
          {eventType !== "" || employeeId !== "" || includeReversed ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                /*
                  Clear this page's OWN narrowing and keep the shared period. The
                  period lives in the analytics params that PeriodBar owns; wiping
                  it as a side effect of clearing a type filter would reset a
                  reader's chosen window without them asking.
                */
                const next = new URLSearchParams();
                for (const key of PERIOD_PARAM_KEYS) {
                  const held = params.get(key);
                  if (held !== null) next.set(key, held);
                }
                setParams(next, { replace: true });
              }}
            >
              {t("admin.transfers.filter.clear")}
            </Button>
          ) : null}
        </div>
      </div>

      {capped ? (
        <div className="mt-3">
          <Notice tone="warning">
            {t("admin.transfers.capped", {
              shown: formatNumber(rows.length),
              total: formatNumber(total.data),
              cap: formatNumber(LIFECYCLE_LIST_LIMIT),
            })}
          </Notice>
        </div>
      ) : null}

      <div className="mt-3">
        <StateBoundary
          loading={events.isPending}
          error={events.error}
          onRetry={() => void events.refetch()}
          isEmpty={rows.length === 0}
          partialError={total.error ?? labels.error}
          partialLabel={t("admin.transfers.partial.total")}
          empty={
            <EmptyState
              icon={Workflow}
              title={t("admin.transfers.empty.title")}
              hint={t("admin.transfers.empty.hint")}
            />
          }
        >
          <DataGrid columns={columns} rows={rows} rowKey={(r) => r.id} pageSize={50} />
        </StateBoundary>
      </div>

      <div className="mt-4">
        <Notice tone="warning">{t("admin.transfers.footnote")}</Notice>
      </div>
    </div>
  );
}

/** The event's own value bags, with ids resolved to names. Never a raw uuid. */
function MovedCell({
  event,
  resolvers,
}: {
  event: LifecycleEvent;
  resolvers: Readonly<Record<RefKind, ReadonlyMap<string, string>>>;
}) {
  const lines: { label: string; from: string; to: string }[] = [];
  for (const spec of VALUE_KEYS) {
    const before = event.from_values?.[spec.key];
    const after = event.to_values?.[spec.key];
    if (before === undefined && after === undefined) continue;
    lines.push({
      label: spec.label,
      from: describe(before, resolvers[spec.ref]),
      to: describe(after, resolvers[spec.ref]),
    });
  }

  if (lines.length === 0) {
    return <span className="text-xs text-muted-foreground">{t("admin.transfers.noValueBag")}</span>;
  }

  return (
    <div className="space-y-0.5">
      {lines.map((line) => (
        <div key={line.label} className="flex flex-wrap items-center gap-1 text-sm">
          <span className="text-xs text-muted-foreground">{line.label}</span>
          <span>{line.from}</span>
          <ArrowRight className="size-3 text-muted-foreground" aria-hidden />
          <span className="font-medium">{line.to}</span>
        </div>
      ))}
    </div>
  );
}

/** One jsonb value, as a label. An id nobody can resolve renders as a dash. */
function describe(value: unknown, resolver: ReadonlyMap<string, string>): string {
  if (value === null || value === undefined) return dash(null);
  if (typeof value === "string") return dash(resolver.get(value) ?? null);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return dash(null);
}

/**
 * Record a movement — an audited UPDATE of the employee master, nothing more and
 * nothing less. The panel shows the CURRENT values beside the new ones so the
 * reason dialog can name the change, and the optimistic lock (`updated_at`) means
 * a stale panel saves nothing instead of overwriting someone else's edit.
 */
function RecordMovement({
  employeeOptions,
  departments,
  sections,
  designations,
  grades,
  codeOf,
}: {
  employeeOptions: readonly { value: string; label: string }[];
  departments: readonly { id: string; name: string }[];
  sections: readonly { id: string; name: string }[];
  designations: readonly { id: string; name: string }[];
  grades: readonly { id: string; name: string }[];
  codeOf: (id: string) => string;
}) {
  const [employeeId, setEmployeeId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [sectionId, setSectionId] = useState("");
  const [designationId, setDesignationId] = useState("");
  const [gradeId, setGradeId] = useState("");
  const [saved, setSaved] = useState<string | null>(null);

  const code = employeeId === "" ? "" : codeOf(employeeId);
  const employee = useAdminEmployee(code);
  const update = useLifecycleEmployeeUpdate(code);

  const input: MovementInput = {
    ...(departmentId !== "" ? { departmentId } : {}),
    ...(sectionId !== "" ? { sectionId } : {}),
    ...(designationId !== "" ? { designationId } : {}),
    ...(gradeId !== "" ? { gradeId } : {}),
  };
  const patch = movementPatch(input);
  const nothingToDo = Object.keys(patch).length === 0;
  const current = employee.data ?? null;

  const describeChange = (): string => {
    const parts: string[] = [];
    if (departmentId !== "")
      parts.push(
        t("admin.transfers.change.department", {
          from: dash(current?.department_name ?? null),
          to: dash(departments.find((d) => d.id === departmentId)?.name ?? null),
        }),
      );
    if (sectionId !== "")
      parts.push(
        t("admin.transfers.change.section", {
          from: dash(current?.section_name ?? null),
          to: dash(sections.find((s) => s.id === sectionId)?.name ?? null),
        }),
      );
    if (designationId !== "")
      parts.push(
        t("admin.transfers.change.designation", {
          from: dash(current?.designation_name ?? null),
          to: dash(designations.find((d) => d.id === designationId)?.name ?? null),
        }),
      );
    if (gradeId !== "")
      parts.push(
        t("admin.transfers.change.grade", {
          from: dash(current?.grade_name ?? null),
          to: dash(grades.find((g) => g.id === gradeId)?.name ?? null),
        }),
      );
    return parts.join(" · ");
  };

  async function apply(reason: string): Promise<void> {
    if (current === null) return;
    await update.saveAsync(
      {
        employeeId: current.id,
        patch,
        expectedUpdatedAt: current.updated_at,
      },
      reason,
    );
    setSaved(current.employee_code);
    setDepartmentId("");
    setSectionId("");
    setDesignationId("");
    setGradeId("");
  }

  return (
    <section className="mt-4 rounded-lg border bg-card p-4">
      <h2 className="font-display text-lg font-semibold">{t("admin.transfers.record.title")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("admin.transfers.record.hint")}</p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <SelectField
          label={t("admin.transfers.record.employee")}
          value={employeeId}
          placeholder={t("admin.transfers.record.pickEmployee")}
          options={employeeOptions}
          onChange={(v) => {
            setEmployeeId(v);
            setSaved(null);
          }}
        />
        <SelectField
          label={t("admin.transfers.field.department")}
          value={departmentId}
          placeholder={
            current === null
              ? t("admin.transfers.record.unchanged")
              : t("admin.transfers.record.currently", { value: dash(current.department_name) })
          }
          options={departments.map((d) => ({ value: d.id, label: d.name }))}
          onChange={setDepartmentId}
        />
        <SelectField
          label={t("admin.transfers.field.section")}
          value={sectionId}
          placeholder={
            current === null
              ? t("admin.transfers.record.unchanged")
              : t("admin.transfers.record.currently", { value: dash(current.section_name) })
          }
          options={sections.map((s) => ({ value: s.id, label: s.name }))}
          onChange={setSectionId}
        />
        <SelectField
          label={t("admin.transfers.field.designation")}
          value={designationId}
          placeholder={
            current === null
              ? t("admin.transfers.record.unchanged")
              : t("admin.transfers.record.currently", { value: dash(current.designation_name) })
          }
          options={designations.map((d) => ({ value: d.id, label: d.name }))}
          onChange={setDesignationId}
        />
        <SelectField
          label={t("admin.transfers.field.grade")}
          value={gradeId}
          placeholder={
            current === null
              ? t("admin.transfers.record.unchanged")
              : t("admin.transfers.record.currently", { value: dash(current.grade_name) })
          }
          options={grades.map((g) => ({ value: g.id, label: g.name }))}
          onChange={setGradeId}
        />
      </div>

      {employee.error !== null ? (
        <div className="mt-3">
          <Notice tone="error">{t("admin.transfers.record.loadFailed")}</Notice>
        </div>
      ) : null}

      {update.userMessage !== null ? (
        <div className="mt-3">
          <Notice tone="error">{update.userMessage}</Notice>
        </div>
      ) : null}

      {saved !== null ? (
        <div className="mt-3">
          <Notice
            tone="success"
            action={
              <Button asChild variant="outline" size="sm">
                <Link to={`/admin/people/${encodeURIComponent(saved)}/audit`}>
                  <History className="mr-2 size-4" aria-hidden />
                  {t("admin.transfers.record.openHistory")}
                </Link>
              </Button>
            }
          >
            {t("admin.transfers.record.saved", { code: saved })}
          </Notice>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <ReasonActionButton
          label={t("admin.transfers.record.apply")}
          title={t("admin.transfers.record.dialogTitle")}
          description={
            current === null
              ? t("admin.transfers.record.pickEmployee")
              : t("admin.transfers.record.dialogDescription", {
                  name: current.display_name,
                  code: current.employee_code,
                  changes: describeChange(),
                })
          }
          confirmLabel={t("admin.transfers.record.confirm")}
          minLength={15}
          variant="default"
          size="default"
          disabled={current === null || nothingToDo || update.isPending}
          disabledHint={t("admin.transfers.record.disabledHint")}
          onConfirm={apply}
        />
        <p className="text-xs text-muted-foreground">{t("admin.transfers.record.effectiveNote")}</p>
      </div>
    </section>
  );
}
