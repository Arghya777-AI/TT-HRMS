/**
 * §2 · /admin/people/onboarding — Onboarding Tasks: every new joiner, and where
 * their confirmation stands.
 *
 * What the database actually gives this screen, established by reading the
 * migrations rather than the spec:
 *
 *  1. `confirmation_due_date` is a GENERATED STORED column —
 *     `date_of_join + probation_months` (migration 008). It is therefore never
 *     computed here, never written, and always agrees with the probation policy
 *     on the record. The "due in 30 days" and "overdue" tiles are server COUNTS
 *     over that column, not a client scan of the loaded rows.
 *  2. `employment_status` is a PROJECTION of the append-only lifecycle event
 *     stream (migration 011). A joiner becomes `on_probation` because a
 *     `probation_started` event was recorded and `confirmed` because a `confirmed`
 *     event was — which is also what stamps `confirmed_on`. So this register
 *     shows the stage and the date side by side and lets them explain each other.
 *  3. THERE IS NO ONBOARDING-TASK TABLE. The nearest deployed thing is
 *     `v_document_compliance`, which expands `document_types.is_required_for_
 *     onboarding` into one row per (employee × required document) with a
 *     server-decided status. That is the checklist this screen opens per joiner —
 *     and it is empty by construction for a `pre_joining` person, because the
 *     view's own WHERE clause starts at `active`. The panel says so rather than
 *     showing a reassuring "all clear".
 *
 * @route /admin/people/onboarding
 */
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ClipboardList, FileText, UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { dash, formatNumber } from "@/lib/format";
import { addIstDays, compareCivilDates, fmtCivilDate, nowIstDate } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField, TextField } from "../components/Field";
import { useRefOptions } from "../hooks/useMasters";
import {
  useLifecycleCount,
  useLifecycleRegister,
  useOnboardingChecklist,
} from "../hooks/usePeopleLifecycle";
import { LIFECYCLE_LIST_LIMIT, type LifecycleEmployee, type LifecycleFilters } from "../api/lifecycle.api";
import { EMPLOYMENT_STATUS_LABELS, type EmploymentStatus } from "../api/employees.api";
import type { ComplianceRow, ComplianceStatus } from "../api/documents.api";

/** The two stages this register is about, plus the outcome it is waiting for. */
const STAGE_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  pre_joining: { label: EMPLOYMENT_STATUS_LABELS.pre_joining, tone: "info" },
  on_probation: { label: EMPLOYMENT_STATUS_LABELS.on_probation, tone: "warn" },
  active: { label: EMPLOYMENT_STATUS_LABELS.active, tone: "success" },
  confirmed: { label: EMPLOYMENT_STATUS_LABELS.confirmed, tone: "success" },
};

const COMPLIANCE_CHIP: Readonly<Record<ComplianceStatus, StatusChipEntry>> = {
  missing: { label: t("admin.onboarding.doc.missing"), tone: "danger" },
  expired: { label: t("admin.onboarding.doc.expired"), tone: "danger" },
  expiring_soon: { label: t("admin.onboarding.doc.expiringSoon"), tone: "warn" },
  valid: { label: t("admin.onboarding.doc.valid"), tone: "success" },
};

/** Which slice of the joiner population the register shows. */
type Slice = "joiners" | "pre_joining" | "on_probation";

const SLICE_STATUSES: Readonly<Record<Slice, readonly EmploymentStatus[]>> = {
  joiners: ["pre_joining", "on_probation"],
  pre_joining: ["pre_joining"],
  on_probation: ["on_probation"],
};

const SLICE_OPTIONS: readonly { value: Slice; label: string }[] = [
  { value: "joiners", label: t("admin.onboarding.slice.joiners") },
  { value: "pre_joining", label: t("admin.onboarding.slice.preJoining") },
  { value: "on_probation", label: t("admin.onboarding.slice.onProbation") },
];

/** The confirmation window, as a server predicate on the generated column. */
type DueWindow = "" | "overdue" | "d7" | "d30" | "d90";

const DUE_OPTIONS: readonly { value: DueWindow; label: string }[] = [
  { value: "", label: t("admin.onboarding.due.any") },
  { value: "overdue", label: t("admin.onboarding.due.overdue") },
  { value: "d7", label: t("admin.onboarding.due.d7") },
  { value: "d30", label: t("admin.onboarding.due.d30") },
  { value: "d90", label: t("admin.onboarding.due.d90") },
];

function isSlice(v: string | null): v is Slice {
  return v === "joiners" || v === "pre_joining" || v === "on_probation";
}

function isDueWindow(v: string | null): v is DueWindow {
  return v === "overdue" || v === "d7" || v === "d30" || v === "d90";
}

/** Window → the `confirmation_due_date` bounds Postgres filters on. */
function dueFilters(window: DueWindow, today: string): LifecycleFilters {
  switch (window) {
    case "":
      return {};
    case "overdue":
      return { hasConfirmationDue: true, dueOnOrBefore: addIstDays(today, -1) };
    case "d7":
      return { hasConfirmationDue: true, dueOnOrAfter: today, dueOnOrBefore: addIstDays(today, 7) };
    case "d30":
      return { hasConfirmationDue: true, dueOnOrAfter: today, dueOnOrBefore: addIstDays(today, 30) };
    case "d90":
      return { hasConfirmationDue: true, dueOnOrAfter: today, dueOnOrBefore: addIstDays(today, 90) };
  }
}

export default function OnboardingPage() {
  const [params, setParams] = useSearchParams();
  const today = nowIstDate();

  const sliceParam = params.get("slice");
  const slice: Slice = isSlice(sliceParam) ? sliceParam : "joiners";
  const dueParam = params.get("due");
  const due: DueWindow = isDueWindow(dueParam) ? dueParam : "";
  const departmentId = params.get("department") ?? "";
  const nameTerm = params.get("q") ?? "";
  const openId = params.get("open");

  const departments = useRefOptions("departments");

  const scope = useMemo<LifecycleFilters>(
    () => ({
      ...(departmentId !== "" ? { departmentIds: [departmentId] } : {}),
      ...(nameTerm.trim() !== "" ? { nameLike: nameTerm.trim() } : {}),
    }),
    [departmentId, nameTerm],
  );

  const filters = useMemo<LifecycleFilters>(
    () => ({
      ...scope,
      statuses: SLICE_STATUSES[slice],
      ...dueFilters(due, today),
    }),
    [scope, slice, due, today],
  );

  // Four independent server counts, each over the predicate its own tile means.
  const preJoiningFilters = useMemo<LifecycleFilters>(
    () => ({ ...scope, statuses: SLICE_STATUSES.pre_joining }),
    [scope],
  );
  const probationFilters = useMemo<LifecycleFilters>(
    () => ({ ...scope, statuses: SLICE_STATUSES.on_probation }),
    [scope],
  );
  const dueSoonFilters = useMemo<LifecycleFilters>(
    () => ({ ...scope, statuses: SLICE_STATUSES.on_probation, ...dueFilters("d30", today) }),
    [scope, today],
  );
  const overdueFilters = useMemo<LifecycleFilters>(
    () => ({ ...scope, statuses: SLICE_STATUSES.on_probation, ...dueFilters("overdue", today) }),
    [scope, today],
  );

  const preJoiningCount = useLifecycleCount(preJoiningFilters);
  const probationCount = useLifecycleCount(probationFilters);
  const dueSoonCount = useLifecycleCount(dueSoonFilters);
  const overdueCount = useLifecycleCount(overdueFilters);

  const listTotal = useLifecycleCount(filters);
  const register = useLifecycleRegister(filters, "confirmationDue");
  const rows = register.data ?? [];
  const openRow = rows.find((r) => r.id === openId) ?? null;

  const hasFilter = departmentId !== "" || nameTerm.trim() !== "" || due !== "" || slice !== "joiners";

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    // A panel opened from the old list must not survive a change of list.
    if (name !== "open") next.delete("open");
    setParams(next, { replace: true });
  }

  function clearAll(): void {
    setParams(new URLSearchParams(), { replace: true });
  }

  const columns: DataGridColumn<LifecycleEmployee>[] = [
    {
      key: "display_name",
      header: t("admin.onboarding.col.joiner"),
      width: "16rem",
      sortable: true,
      render: (r) => (
        <PersonCell name={r.display_name} code={r.employee_code} secondary={r.designation_name} />
      ),
    },
    {
      key: "employment_status",
      header: t("admin.onboarding.col.stage"),
      width: "9rem",
      render: (r) => <StatusChip status={r.employment_status} map={STAGE_CHIP} />,
    },
    {
      key: "department_name",
      header: t("admin.onboarding.col.department"),
      hideBelow: "md",
      render: (r) => dash(r.department_name),
    },
    {
      key: "date_of_join",
      header: t("admin.onboarding.col.joins"),
      width: "9rem",
      align: "right",
      render: (r) => <span className="num">{fmtCivilDate(r.date_of_join)}</span>,
    },
    {
      key: "probation_months",
      header: t("admin.onboarding.col.probation"),
      width: "8rem",
      align: "right",
      hideBelow: "lg",
      render: (r) => (
        <span className="num">
          {t("admin.onboarding.months", { n: formatNumber(r.probation_months) })}
        </span>
      ),
    },
    {
      key: "confirmation_due_date",
      header: t("admin.onboarding.col.confirmationDue"),
      width: "11rem",
      align: "right",
      // The value is the GENERATED column; the tone is a date comparison against
      // today in IST, and the tile above is the server's own count of the slice.
      render: (r) => {
        if (r.confirmation_due_date === null) {
          return <span className="text-xs text-muted-foreground">{t("admin.onboarding.noDue")}</span>;
        }
        const overdue =
          r.confirmed_on === null && compareCivilDates(r.confirmation_due_date, today) < 0;
        return (
          <span className={overdue ? "num text-destructive" : "num"}>
            {fmtCivilDate(r.confirmation_due_date)}
          </span>
        );
      },
    },
    {
      key: "confirmed_on",
      header: t("admin.onboarding.col.confirmedOn"),
      width: "10rem",
      align: "right",
      hideBelow: "md",
      render: (r) =>
        r.confirmed_on === null ? (
          <span className="text-xs text-muted-foreground">{t("admin.onboarding.notConfirmed")}</span>
        ) : (
          <span className="num text-success">{fmtCivilDate(r.confirmed_on)}</span>
        ),
    },
    {
      key: "reporting_manager_name",
      header: t("admin.onboarding.col.manager"),
      hideBelow: "lg",
      render: (r) => dash(r.reporting_manager_name),
    },
  ];

  const capped = listTotal.isSuccess && listTotal.data > rows.length;

  return (
    <div className="container py-6">
      <PageHeader
        icon={ClipboardList}
        title={t("admin.onboarding.title")}
        subtitle={
          listTotal.isSuccess
            ? t("admin.onboarding.subtitle.count", { n: formatNumber(listTotal.data) })
            : t("admin.onboarding.subtitle.plain")
        }
        actions={
          <Button asChild>
            <Link to="/admin/people/new">
              <UserPlus className="mr-2 size-4" aria-hidden />
              {t("admin.onboarding.action.add")}
            </Link>
          </Button>
        }
      />

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label={t("admin.onboarding.tile.preJoining")}
          hint={t("admin.onboarding.tile.preJoiningHint")}
          query={preJoiningCount}
          onClick={() => setParam("slice", "pre_joining")}
        />
        <Tile
          label={t("admin.onboarding.tile.onProbation")}
          hint={t("admin.onboarding.tile.onProbationHint")}
          query={probationCount}
          onClick={() => setParam("slice", "on_probation")}
        />
        <Tile
          label={t("admin.onboarding.tile.dueSoon")}
          hint={t("admin.onboarding.tile.dueSoonHint")}
          query={dueSoonCount}
          onClick={() => {
            const next = new URLSearchParams(params);
            next.set("slice", "on_probation");
            next.set("due", "d30");
            next.delete("open");
            setParams(next, { replace: true });
          }}
        />
        <Tile
          label={t("admin.onboarding.tile.overdue")}
          hint={t("admin.onboarding.tile.overdueHint")}
          tone="danger"
          query={overdueCount}
          onClick={() => {
            const next = new URLSearchParams(params);
            next.set("slice", "on_probation");
            next.set("due", "overdue");
            next.delete("open");
            setParams(next, { replace: true });
          }}
        />
      </div>

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <SelectField
          label={t("admin.onboarding.filter.slice")}
          value={slice}
          options={SLICE_OPTIONS}
          onChange={(v) => setParam("slice", v)}
        />
        <SelectField
          label={t("admin.onboarding.filter.due")}
          value={due}
          options={DUE_OPTIONS}
          onChange={(v) => setParam("due", v)}
          hint={t("admin.onboarding.filter.dueHint")}
        />
        <SelectField
          label={t("admin.onboarding.filter.department")}
          value={departmentId}
          placeholder={t("admin.onboarding.filter.anyDepartment")}
          options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
          onChange={(v) => setParam("department", v)}
        />
        <div className="flex items-end gap-2">
          <TextField
            label={t("admin.onboarding.filter.name")}
            value={nameTerm}
            onChange={(v) => setParam("q", v)}
            placeholder={t("admin.onboarding.filter.namePlaceholder")}
          />
        </div>
        {hasFilter ? (
          <div className="flex items-end">
            <Button type="button" variant="ghost" onClick={clearAll}>
              {t("admin.onboarding.filter.clear")}
            </Button>
          </div>
        ) : null}
      </div>

      {capped ? (
        <div className="mt-4">
          <Notice tone="warning">
            {t("admin.onboarding.capped", {
              shown: formatNumber(rows.length),
              total: formatNumber(listTotal.data),
              cap: formatNumber(LIFECYCLE_LIST_LIMIT),
            })}
          </Notice>
        </div>
      ) : null}

      {openRow !== null ? (
        <ChecklistPanel row={openRow} onClose={() => setParam("open", "")} />
      ) : null}

      <div className="mt-4">
        <StateBoundary
          loading={register.isPending}
          error={register.error}
          onRetry={() => void register.refetch()}
          isEmpty={rows.length === 0}
          partialError={listTotal.error}
          partialLabel={t("admin.onboarding.partial.total")}
          empty={
            <EmptyState
              icon={ClipboardList}
              title={t("admin.onboarding.empty.title")}
              hint={t("admin.onboarding.empty.hint")}
              {...(hasFilter
                ? {
                    action: (
                      <Button variant="outline" onClick={clearAll}>
                        {t("admin.onboarding.filter.clear")}
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
            onRowClick={(r) => setParam("open", r.id)}
          />
        </StateBoundary>
      </div>

      <div className="mt-4">
        <Notice tone="info">{t("admin.onboarding.footnote")}</Notice>
      </div>
    </div>
  );
}

/** A tile whose number is a Postgres COUNT over the slice it opens. */
function Tile({
  label,
  hint,
  query,
  tone = "neutral",
  onClick,
}: {
  label: string;
  hint: string;
  query: { data: number | undefined; error: Error | null; isPending: boolean };
  tone?: "neutral" | "danger";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={
          tone === "danger"
            ? "num mt-1 font-display text-2xl font-semibold text-destructive"
            : "num mt-1 font-display text-2xl font-semibold"
        }
      >
        {query.isPending
          ? "…"
          : query.error !== null
            ? t("common.empty")
            : formatNumber(query.data)}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </button>
  );
}

/**
 * One joiner's required-document checklist — the only onboarding checklist the
 * database has. Every row's status was decided by the view, including the
 * 60-day expiring band, which is fixed in SQL and not a client threshold.
 */
function ChecklistPanel({ row, onClose }: { row: LifecycleEmployee; onClose: () => void }) {
  const checklist = useOnboardingChecklist(row.id);
  const items = checklist.data ?? [];

  const columns: DataGridColumn<ComplianceRow>[] = [
    {
      key: "document_type_name",
      header: t("admin.onboarding.doc.col.type"),
      render: (r) => r.document_type_name,
    },
    {
      key: "compliance_status",
      header: t("admin.onboarding.doc.col.status"),
      width: "10rem",
      render: (r) => <StatusChip status={r.compliance_status} map={COMPLIANCE_CHIP} />,
    },
    {
      key: "expiry_date",
      header: t("admin.onboarding.doc.col.expiry"),
      width: "10rem",
      align: "right",
      render: (r) => <span className="num">{fmtCivilDate(r.expiry_date)}</span>,
    },
  ];

  return (
    <section className="mt-4 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold">
            {t("admin.onboarding.doc.title")}
          </h2>
          <PersonCell
            name={row.display_name}
            code={row.employee_code}
            secondary={row.designation_name}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to={`/admin/people/${encodeURIComponent(row.employee_code)}`}>
              {t("admin.onboarding.doc.openPerson")}
            </Link>
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="mr-1 size-4" aria-hidden />
            {t("admin.onboarding.doc.close")}
          </Button>
        </div>
      </div>

      {row.employment_status === "pre_joining" ? (
        <div className="mt-3">
          <Notice tone="info">{t("admin.onboarding.doc.preJoiningNotice")}</Notice>
        </div>
      ) : null}

      <div className="mt-3">
        <StateBoundary
          loading={checklist.isPending}
          error={checklist.error}
          onRetry={() => void checklist.refetch()}
          isEmpty={items.length === 0}
          skeletonRows={2}
          empty={
            <EmptyState
              icon={FileText}
              title={t("admin.onboarding.doc.empty.title")}
              hint={t("admin.onboarding.doc.empty.hint")}
            />
          }
        >
          <DataGrid
            columns={columns}
            rows={items}
            rowKey={(r) => `${r.employee_id}:${r.document_type_id}`}
            pageSize={100}
          />
        </StateBoundary>
      </div>
    </section>
  );
}
