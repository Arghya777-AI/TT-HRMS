/**
 * §2 · /admin/people/lifecycle — Lifecycle Board. Joiners, probation, notice and
 * exits by stage.
 *
 * The one fact this screen exists to make visible: `employees.employment_status`
 * is not a field someone types. It is a PROJECTION of the append-only
 * `employee_lifecycle_events` stream — migration 011's `trg_ele__status_projection`
 * maps `joined → active`, `confirmed → confirmed`, `resigned → on_notice`,
 * `terminated → exited`, and stamps `confirmed_on` / `resignation_date` /
 * `last_working_day` / `exit_type` while it is at it. So a stage on this board is
 * the consequence of a recorded event, and the board says so.
 *
 * Three rules held here:
 *
 *  1. EVERY TILE IS A SERVER COUNT. One `count=exact` per employment status,
 *     built from the same `LifecycleFilters` object as the register below
 *     (`lifecycle.api.ts` owns both predicates), so a tile and the list it opens
 *     cannot disagree — and a tile's zero means "Postgres counted zero".
 *  2. THE STAGE AND THE FILTERS LIVE IN THE URL, so a stage is a link an
 *     administrator can send to a colleague.
 *  3. THE LIST IS CAPPED AND SAYS SO. A register read is at most 200 rows while
 *     its count is unbounded; when the cap bites, the screen prints "showing the
 *     first 200 of N" rather than implying the list is complete.
 *
 * No arithmetic: dates, statuses and counts are all server values.
 *
 * @route /admin/people/lifecycle
 */
import { useMemo } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Users, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { dash, formatNumber } from "@/lib/format";
import { fmtCivilDate } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField, TextField } from "../components/Field";
import { useRefOptions } from "../hooks/useMasters";
import {
  useLifecycleCount,
  useLifecycleRegister,
  useLifecycleStageCounts,
} from "../hooks/usePeopleLifecycle";
import { LIFECYCLE_LIST_LIMIT, type LifecycleEmployee, type LifecycleFilters } from "../api/lifecycle.api";
import {
  EMPLOYMENT_STATUS_LABELS,
  employmentStatusValues,
  type EmploymentStatus,
} from "../api/employees.api";

/**
 * Tone per stage. `absconding` and `suspended` are the two an admin must never
 * miss in a scan of the board, so they are the only danger tones (DR-45).
 */
const STAGE_CHIP: Readonly<Record<EmploymentStatus, StatusChipEntry>> = {
  pre_joining: { label: EMPLOYMENT_STATUS_LABELS.pre_joining, tone: "info" },
  active: { label: EMPLOYMENT_STATUS_LABELS.active, tone: "success" },
  on_probation: { label: EMPLOYMENT_STATUS_LABELS.on_probation, tone: "warn" },
  confirmed: { label: EMPLOYMENT_STATUS_LABELS.confirmed, tone: "success" },
  on_notice: { label: EMPLOYMENT_STATUS_LABELS.on_notice, tone: "warn" },
  suspended: { label: EMPLOYMENT_STATUS_LABELS.suspended, tone: "danger" },
  on_long_leave: { label: EMPLOYMENT_STATUS_LABELS.on_long_leave, tone: "info" },
  absconding: { label: EMPLOYMENT_STATUS_LABELS.absconding, tone: "danger" },
  exited: { label: EMPLOYMENT_STATUS_LABELS.exited, tone: "neutral" },
  retired: { label: EMPLOYMENT_STATUS_LABELS.retired, tone: "neutral" },
  rehired: { label: EMPLOYMENT_STATUS_LABELS.rehired, tone: "info" },
};

const TONE_RING: Readonly<Record<string, string>> = {
  success: "border-success/50",
  info: "border-info/50",
  warn: "border-warning/50",
  danger: "border-destructive/50",
  neutral: "border-border",
};

/** One line per stage saying which recorded event puts a person there. */
const STAGE_CAUSE: Readonly<Record<EmploymentStatus, string>> = {
  pre_joining: t("admin.lifecycle.cause.pre_joining"),
  active: t("admin.lifecycle.cause.active"),
  on_probation: t("admin.lifecycle.cause.on_probation"),
  confirmed: t("admin.lifecycle.cause.confirmed"),
  on_notice: t("admin.lifecycle.cause.on_notice"),
  suspended: t("admin.lifecycle.cause.suspended"),
  on_long_leave: t("admin.lifecycle.cause.on_long_leave"),
  absconding: t("admin.lifecycle.cause.absconding"),
  exited: t("admin.lifecycle.cause.exited"),
  retired: t("admin.lifecycle.cause.retired"),
  rehired: t("admin.lifecycle.cause.rehired"),
};

function isEmploymentStatus(value: string | null): value is EmploymentStatus {
  return value !== null && employmentStatusValues.some((s) => s === value);
}

export default function LifecyclePage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const stageParam = params.get("stage");
  const stage: EmploymentStatus | "" = isEmploymentStatus(stageParam) ? stageParam : "";
  const departmentId = params.get("department") ?? "";
  const locationId = params.get("location") ?? "";
  const nameTerm = params.get("q") ?? "";

  const departments = useRefOptions("departments");
  const locations = useRefOptions("locations");

  /** The scope every tile and the register share, minus the stage itself. */
  const base = useMemo<LifecycleFilters>(
    () => ({
      ...(departmentId !== "" ? { departmentIds: [departmentId] } : {}),
      ...(locationId !== "" ? { locationIds: [locationId] } : {}),
      ...(nameTerm.trim() !== "" ? { nameLike: nameTerm.trim() } : {}),
    }),
    [departmentId, locationId, nameTerm],
  );

  const filters = useMemo<LifecycleFilters>(
    () => ({ ...base, ...(stage !== "" ? { statuses: [stage] } : {}) }),
    [base, stage],
  );

  // The tiles keep counting their own stage while one is selected: a board whose
  // other numbers vanish on click stops being a board.
  const stageCounts = useLifecycleStageCounts(base, employmentStatusValues);
  const scopeTotal = useLifecycleCount(base);
  const listTotal = useLifecycleCount(filters);
  const register = useLifecycleRegister(filters, "code");
  const rows = register.data ?? [];

  const hasFilter = departmentId !== "" || locationId !== "" || nameTerm.trim() !== "";

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: true });
  }

  function clearAll(): void {
    setParams(new URLSearchParams(), { replace: true });
  }

  const columns: DataGridColumn<LifecycleEmployee>[] = [
    {
      key: "display_name",
      header: t("admin.lifecycle.col.employee"),
      width: "16rem",
      sortable: true,
      render: (r) => (
        <PersonCell name={r.display_name} code={r.employee_code} secondary={r.designation_name} />
      ),
    },
    {
      key: "employment_status",
      header: t("admin.lifecycle.col.stage"),
      width: "9rem",
      sortable: true,
      render: (r) => <StatusChip status={r.employment_status} map={STAGE_CHIP} />,
    },
    {
      key: "department_name",
      header: t("admin.lifecycle.col.department"),
      render: (r) => dash(r.department_name),
    },
    {
      key: "location_name",
      header: t("admin.lifecycle.col.location"),
      hideBelow: "lg",
      render: (r) => dash(r.location_name),
    },
    {
      key: "date_of_join",
      header: t("admin.lifecycle.col.joined"),
      width: "9rem",
      align: "right",
      sortable: true,
      render: (r) => <span className="num">{fmtCivilDate(r.date_of_join)}</span>,
    },
    {
      key: "confirmation_due_date",
      header: t("admin.lifecycle.col.confirmationDue"),
      width: "10rem",
      align: "right",
      hideBelow: "md",
      // GENERATED column (date_of_join + probation_months) — never computed here.
      render: (r) =>
        r.confirmed_on !== null ? (
          <span className="num text-success">{fmtCivilDate(r.confirmed_on)}</span>
        ) : (
          <span className="num">{fmtCivilDate(r.confirmation_due_date)}</span>
        ),
    },
    {
      key: "last_working_day",
      header: t("admin.lifecycle.col.lastWorkingDay"),
      width: "10rem",
      align: "right",
      hideBelow: "md",
      render: (r) => <span className="num">{fmtCivilDate(r.last_working_day)}</span>,
    },
    {
      key: "reporting_manager_name",
      header: t("admin.lifecycle.col.manager"),
      hideBelow: "lg",
      render: (r) => dash(r.reporting_manager_name),
    },
  ];

  const capped = listTotal.isSuccess && listTotal.data > rows.length;

  return (
    <div className="container py-6">
      <PageHeader
        icon={Workflow}
        title={t("admin.lifecycle.title")}
        subtitle={
          scopeTotal.isSuccess
            ? t("admin.lifecycle.subtitle.count", { n: formatNumber(scopeTotal.data) })
            : t("admin.lifecycle.subtitle.plain")
        }
        actions={
          <Button asChild variant="outline">
            <Link to="/admin/people">{t("admin.lifecycle.action.directory")}</Link>
          </Button>
        }
      />

      {/* One server count per stage; each tile is the filter it opens. */}
      <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {employmentStatusValues.map((value) => {
          const q = stageCounts.find((s) => s.status === value);
          const active = stage === value;
          const chip = STAGE_CHIP[value];
          return (
            <button
              key={value}
              type="button"
              onClick={() => setParam("stage", active ? "" : value)}
              aria-pressed={active}
              className={cn(
                "rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                TONE_RING[chip.tone],
                active && "ring-2 ring-primary",
              )}
            >
              <p className="text-xs text-muted-foreground">{chip.label}</p>
              <p className="num mt-1 font-display text-2xl font-semibold">
                {q === undefined || q.isPending
                  ? "…"
                  : q.error !== null
                    ? t("common.empty")
                    : formatNumber(q.count)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{STAGE_CAUSE[value]}</p>
            </button>
          );
        })}
      </div>

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <TextField
          label={t("admin.lifecycle.filter.name")}
          value={nameTerm}
          onChange={(v) => setParam("q", v)}
          placeholder={t("admin.lifecycle.filter.namePlaceholder")}
        />
        <SelectField
          label={t("admin.lifecycle.filter.department")}
          value={departmentId}
          placeholder={t("admin.lifecycle.filter.anyDepartment")}
          options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
          onChange={(v) => setParam("department", v)}
        />
        <SelectField
          label={t("admin.lifecycle.filter.location")}
          value={locationId}
          placeholder={t("admin.lifecycle.filter.anyLocation")}
          options={(locations.data ?? []).map((l) => ({ value: l.id, label: l.name }))}
          onChange={(v) => setParam("location", v)}
        />
        <div className="flex flex-wrap items-end gap-2">
          <Button asChild variant="outline">
            <Link to="/admin/people/onboarding">{t("admin.lifecycle.action.onboarding")}</Link>
          </Button>
          {hasFilter || stage !== "" ? (
            <Button type="button" variant="ghost" onClick={clearAll}>
              {t("admin.lifecycle.filter.clear")}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <Link to="/admin/people/transfers">{t("admin.lifecycle.action.transfers")}</Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link to="/admin/people/exits">{t("admin.lifecycle.action.exits")}</Link>
        </Button>
      </div>

      <h2 className="mt-6 font-display text-lg font-semibold">
        {stage === ""
          ? t("admin.lifecycle.list.allStages")
          : t("admin.lifecycle.list.oneStage", { stage: STAGE_CHIP[stage].label })}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {listTotal.isSuccess
          ? t("admin.lifecycle.list.count", { n: formatNumber(listTotal.data) })
          : t("admin.lifecycle.list.countUnknown")}
      </p>

      {capped ? (
        <div className="mt-3">
          <Notice tone="warning">
            {t("admin.lifecycle.capped", {
              shown: formatNumber(rows.length),
              total: formatNumber(listTotal.data),
              cap: formatNumber(LIFECYCLE_LIST_LIMIT),
            })}
          </Notice>
        </div>
      ) : null}

      <div className="mt-3">
        <StateBoundary
          loading={register.isPending}
          error={register.error}
          onRetry={() => void register.refetch()}
          isEmpty={rows.length === 0}
          partialError={listTotal.error ?? scopeTotal.error}
          partialLabel={t("admin.lifecycle.partial.total")}
          empty={
            <EmptyState
              icon={Users}
              title={
                stage === ""
                  ? t("admin.lifecycle.empty.title")
                  : t("admin.lifecycle.empty.stage.title", { stage: STAGE_CHIP[stage].label })
              }
              hint={t("admin.lifecycle.empty.hint")}
              {...(hasFilter || stage !== ""
                ? {
                    action: (
                      <Button variant="outline" onClick={clearAll}>
                        {t("admin.lifecycle.filter.clear")}
                      </Button>
                    ),
                  }
                : {})}
            />
          }
        >
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            pageSize={50}
            onRowClick={(r) =>
              void navigate(`/admin/people/${encodeURIComponent(r.employee_code)}`)
            }
          />
        </StateBoundary>
      </div>

      <div className="mt-4">
        <Notice tone="info">{t("admin.lifecycle.footnote")}</Notice>
      </div>
    </div>
  );
}
