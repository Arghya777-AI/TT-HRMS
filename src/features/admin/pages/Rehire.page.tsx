/**
 * §2 · /admin/people/rehire — bringing a former employee back.
 *
 * RECON FIRST, and it splits this screen in two, because the database supports
 * exactly one of the two halves as a write:
 *
 *  1. THE DECISION IS A COLUMN AN ADMIN OWNS. `employees.is_rehire_eligible` is a
 *     NULLABLE boolean inside the granted UPDATE set (`EDITABLE_EXIT_COLUMNS`,
 *     migration 051 §2) — so "eligible", "not eligible" and "nobody has ruled"
 *     are three distinct states, and the undecided pile is what this register is
 *     for. Setting it is one audited `updateEmployee` with a typed reason and an
 *     optimistic lock on the version on screen.
 *  2. THE REHIRE ITSELF IS A LIFECYCLE EVENT NOBODY CAN INSERT FROM HERE.
 *     `employment_status = 'rehired'` is written only by
 *     `trg_ele__status_projection` when a `rehired` event is INSERTed into
 *     `employee_lifecycle_events` (migration 011 §1), and no deployed RPC or edge
 *     function records that event. So this screen shows the rehires already on
 *     record and states plainly that the act of rehiring is a server-side gap —
 *     it does NOT offer a button that would quietly do something else.
 *
 * And it must not offer "create them again" as a substitute: `employee_code` is
 * allocated by trigger and immutable (D-02), so a second row is a second person
 * with the same face, splitting their service, leave ledger and payroll history.
 * History intact means ONE row, reactivated.
 *
 * @route /admin/people/rehire
 */
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { RotateCcw, UserCheck, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SENSITIVE_REASON_LENGTH } from "@/shared/api/query";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { useReasonPrompt } from "../hooks/useReasonPrompt";
import { useRecordLifecycleEvent } from "../hooks/usePeopleLifecycle";
import { useProfileId } from "@/shared/api/employee-scope";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { dash, formatNumber } from "@/lib/format";
import { nowIstDate, fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { ReasonActionButton } from "../components/ReasonActionButton";
import { SelectField, TextField } from "../components/Field";
import { useEmployeeLabels } from "../hooks/useEmployeeLabels";
import { useRefOptions } from "../hooks/useMasters";
import {
  useLifecycleCount,
  useLifecycleEmployeeUpdate,
  useLifecycleEventCount,
  useLifecycleEvents,
  useLifecycleRegister,
} from "../hooks/usePeopleLifecycle";
import {
  EXIT_TYPE_LABELS,
  LIFECYCLE_LIST_LIMIT,
  type LifecycleEmployee,
  type LifecycleEvent,
  type LifecycleEventFilters,
  type LifecycleFilters,
} from "../api/lifecycle.api";
import { EMPLOYMENT_STATUS_LABELS, type EmploymentStatus } from "../api/employees.api";

/** The stages a former employee can be sitting in. */
const STAGE_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  exited: { label: EMPLOYMENT_STATUS_LABELS.exited, tone: "neutral" },
  retired: { label: EMPLOYMENT_STATUS_LABELS.retired, tone: "neutral" },
  absconding: { label: EMPLOYMENT_STATUS_LABELS.absconding, tone: "danger" },
  rehired: { label: EMPLOYMENT_STATUS_LABELS.rehired, tone: "success" },
};

const EXIT_TYPE_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  resignation: { label: EXIT_TYPE_LABELS.resignation, tone: "info" },
  termination: { label: EXIT_TYPE_LABELS.termination, tone: "danger" },
  end_of_contract: { label: EXIT_TYPE_LABELS.end_of_contract, tone: "neutral" },
  retirement: { label: EXIT_TYPE_LABELS.retirement, tone: "neutral" },
  absconding: { label: EXIT_TYPE_LABELS.absconding, tone: "danger" },
  death: { label: EXIT_TYPE_LABELS.death, tone: "neutral" },
};

/** Former employees, by what has been decided about their return. */
type Decision = "undecided" | "eligible" | "not_eligible" | "all";

const DECISION_OPTIONS: readonly { value: Decision; label: string }[] = [
  { value: "undecided", label: t("admin.rehire.decision.undecided") },
  { value: "eligible", label: t("admin.rehire.decision.eligible") },
  { value: "not_eligible", label: t("admin.rehire.decision.notEligible") },
  { value: "all", label: t("admin.rehire.decision.all") },
];

/** The three stages someone can leave in. `rehired` is not a leaver. */
const FORMER_STATUSES: readonly EmploymentStatus[] = ["exited", "retired", "absconding"];

const REHIRE_EVENTS: LifecycleEventFilters = { eventTypes: ["rehired"] };

function isDecision(v: string | null): v is Decision {
  return v === "undecided" || v === "eligible" || v === "not_eligible" || v === "all";
}

/** Decision → the predicate on the nullable boolean. Never a client-side scan. */
function decisionFilters(decision: Decision): LifecycleFilters {
  switch (decision) {
    case "undecided":
      return { rehireDecided: false };
    case "eligible":
      return { rehireEligible: true };
    case "not_eligible":
      return { rehireEligible: false };
    case "all":
      return {};
  }
}

export default function RehirePage() {
  const [params, setParams] = useSearchParams();

  const decisionParam = params.get("decision");
  const decision: Decision = isDecision(decisionParam) ? decisionParam : "eligible";
  const departmentId = params.get("department") ?? "";
  const nameTerm = params.get("q") ?? "";
  const openId = params.get("open");

  const departments = useRefOptions("departments");
  const labels = useEmployeeLabels();

  const scope = useMemo<LifecycleFilters>(
    () => ({
      statuses: FORMER_STATUSES,
      ...(departmentId !== "" ? { departmentIds: [departmentId] } : {}),
      ...(nameTerm.trim() !== "" ? { nameLike: nameTerm.trim() } : {}),
    }),
    [departmentId, nameTerm],
  );

  const filters = useMemo<LifecycleFilters>(
    () => ({ ...scope, ...decisionFilters(decision) }),
    [scope, decision],
  );

  const eligibleFilters = useMemo<LifecycleFilters>(
    () => ({ ...scope, rehireEligible: true }),
    [scope],
  );
  const notEligibleFilters = useMemo<LifecycleFilters>(
    () => ({ ...scope, rehireEligible: false }),
    [scope],
  );
  const undecidedFilters = useMemo<LifecycleFilters>(
    () => ({ ...scope, rehireDecided: false }),
    [scope],
  );

  const eligibleCount = useLifecycleCount(eligibleFilters);
  const notEligibleCount = useLifecycleCount(notEligibleFilters);
  const undecidedCount = useLifecycleCount(undecidedFilters);
  const rehiredCount = useLifecycleEventCount(REHIRE_EVENTS);

  const listTotal = useLifecycleCount(filters);
  const register = useLifecycleRegister(filters, "lastWorkingDay");
  const rows = register.data ?? [];
  const openRow = rows.find((r) => r.id === openId) ?? null;

  const rehires = useLifecycleEvents(REHIRE_EVENTS);
  const rehireRows = rehires.data ?? [];

  const hasFilter = decision !== "eligible" || departmentId !== "" || nameTerm.trim() !== "";

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    if (name !== "open") next.delete("open");
    setParams(next, { replace: true });
  }

  function clearAll(): void {
    setParams(new URLSearchParams(), { replace: true });
  }

  /*
    Who is being brought back. The rehire itself is a `rehired` lifecycle event —
    the projection trigger sets `employment_status = 'rehired'` from it, which is
    exactly why re-creating the person is the wrong answer: one row, reactivated,
    keeps their service, leave ledger and payroll history intact.
  */
  const prompt = useReasonPrompt<{ employee: LifecycleEmployee }>();
  const rehire = useRecordLifecycleEvent();
  const actorProfileId = useProfileId();

  const columns: DataGridColumn<LifecycleEmployee>[] = [
    {
      /*
        THE ACT THIS SCREEN SAID IT COULD NOT PERFORM.

        Its header stated that "no deployed RPC or edge function records that
        event", and read the absence of an RPC as the absence of a write path.
        `ele__admin_insert` (migration 011) has permitted an administrator to
        append the event all along, and `trg_ele__status_projection` turns it into
        `employment_status = 'rehired'` inside the same transaction. One insert,
        one status, one history.
      */
      key: "rehire",
      header: t("admin.rehire.col.action"),
      width: "9rem",
      render: (r) =>
        r.employment_status === "rehired" ? (
          <span className="text-xs text-muted-foreground">{t("admin.rehire.alreadyBack")}</span>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              prompt.ask({ employee: r });
            }}
          >
            <UserCheck className="mr-1.5 size-3.5" aria-hidden />
            {t("admin.rehire.bringBack")}
          </Button>
        ),
    },
    {
      key: "display_name",
      header: t("admin.rehire.col.person"),
      width: "16rem",
      sortable: true,
      render: (r) => (
        <PersonCell name={r.display_name} code={r.employee_code} secondary={r.designation_name} />
      ),
    },
    {
      key: "employment_status",
      header: t("admin.rehire.col.stage"),
      width: "9rem",
      render: (r) => <StatusChip status={r.employment_status} map={STAGE_CHIP} />,
    },
    {
      key: "exit_type",
      header: t("admin.rehire.col.leftAs"),
      width: "10rem",
      render: (r) =>
        r.exit_type === null ? (
          <span className="text-xs text-muted-foreground">{t("admin.rehire.noExitType")}</span>
        ) : (
          <StatusChip status={r.exit_type} map={EXIT_TYPE_CHIP} />
        ),
    },
    {
      key: "date_of_join",
      header: t("admin.rehire.col.joined"),
      width: "9rem",
      align: "right",
      hideBelow: "lg",
      render: (r) => <span className="num">{fmtCivilDate(r.date_of_join)}</span>,
    },
    {
      key: "last_working_day",
      header: t("admin.rehire.col.left"),
      width: "10rem",
      align: "right",
      sortable: true,
      render: (r) => <span className="num">{fmtCivilDate(r.last_working_day)}</span>,
    },
    {
      key: "department_name",
      header: t("admin.rehire.col.department"),
      hideBelow: "md",
      render: (r) => dash(r.department_name),
    },
    {
      key: "full_and_final_settled_on",
      header: t("admin.rehire.col.settled"),
      width: "10rem",
      align: "right",
      hideBelow: "lg",
      render: (r) =>
        r.full_and_final_settled_on === null ? (
          <span className="text-xs text-warning">{t("admin.rehire.settlementOpen")}</span>
        ) : (
          <span className="num text-success">{fmtCivilDate(r.full_and_final_settled_on)}</span>
        ),
    },
    {
      key: "is_rehire_eligible",
      header: t("admin.rehire.col.decision"),
      width: "10rem",
      render: (r) =>
        r.is_rehire_eligible === null ? (
          <span className="text-xs text-muted-foreground">
            {t("admin.rehire.decision.undecidedShort")}
          </span>
        ) : r.is_rehire_eligible ? (
          <span className="text-xs text-success">{t("admin.rehire.decision.eligibleShort")}</span>
        ) : (
          <span className="text-xs text-destructive">
            {t("admin.rehire.decision.notEligibleShort")}
          </span>
        ),
    },
  ];

  const rehireColumns: DataGridColumn<LifecycleEvent>[] = [
    {
      key: "effective_date",
      header: t("admin.rehire.event.col.effective"),
      width: "10rem",
      render: (r) => <span className="num">{fmtCivilDate(r.effective_date)}</span>,
    },
    {
      key: "employee_id",
      header: t("admin.rehire.event.col.person"),
      width: "16rem",
      render: (r) => {
        const label = labels.data?.get(r.employee_id);
        return label === undefined ? (
          <span className="text-sm text-muted-foreground">{t("admin.rehire.event.unknown")}</span>
        ) : (
          <PersonCell name={label.name} code={label.code} secondary={label.department} />
        );
      },
    },
    {
      key: "reason",
      header: t("admin.rehire.event.col.reason"),
      render: (r) => <span className="text-sm">{r.reason}</span>,
    },
    {
      key: "recorded_at",
      header: t("admin.rehire.event.col.recorded"),
      width: "12rem",
      align: "right",
      hideBelow: "md",
      render: (r) => <span className="num text-xs">{fmtDateTime(r.recorded_at)}</span>,
    },
  ];

  const capped = listTotal.isSuccess && listTotal.data > rows.length;

  return (
    <div className="container py-6">
      <PageHeader
        icon={RotateCcw}
        title={t("admin.rehire.title")}
        subtitle={
          listTotal.isSuccess
            ? t("admin.rehire.subtitle.count", { n: formatNumber(listTotal.data) })
            : t("admin.rehire.subtitle.plain")
        }
      />

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label={t("admin.rehire.tile.eligible")}
          hint={t("admin.rehire.tile.eligibleHint")}
          query={eligibleCount}
          onClick={() => setParam("decision", "eligible")}
        />
        <Tile
          label={t("admin.rehire.tile.undecided")}
          hint={t("admin.rehire.tile.undecidedHint")}
          query={undecidedCount}
          onClick={() => setParam("decision", "undecided")}
        />
        <Tile
          label={t("admin.rehire.tile.notEligible")}
          hint={t("admin.rehire.tile.notEligibleHint")}
          query={notEligibleCount}
          onClick={() => setParam("decision", "not_eligible")}
        />
        <Tile
          label={t("admin.rehire.tile.rehired")}
          hint={t("admin.rehire.tile.rehiredHint")}
          query={rehiredCount}
          onClick={() => setParam("decision", "all")}
        />
      </div>

      <div className="mt-4">
        <Notice tone="note">{t("admin.rehire.gapNotice")}</Notice>
      </div>

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <SelectField
          label={t("admin.rehire.filter.decision")}
          value={decision}
          options={DECISION_OPTIONS}
          onChange={(v) => setParam("decision", v)}
        />
        <SelectField
          label={t("admin.rehire.filter.department")}
          value={departmentId}
          placeholder={t("admin.rehire.filter.anyDepartment")}
          options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
          onChange={(v) => setParam("department", v)}
          hint={t("admin.rehire.filter.departmentHint")}
        />
        <TextField
          label={t("admin.rehire.filter.name")}
          value={nameTerm}
          onChange={(v) => setParam("q", v)}
          placeholder={t("admin.rehire.filter.namePlaceholder")}
        />
        {hasFilter ? (
          <div className="flex items-end">
            <Button type="button" variant="ghost" onClick={clearAll}>
              {t("admin.rehire.filter.clear")}
            </Button>
          </div>
        ) : null}
      </div>

      {capped ? (
        <div className="mt-4">
          <Notice tone="warning">
            {t("admin.rehire.capped", {
              shown: formatNumber(rows.length),
              total: formatNumber(listTotal.data),
              cap: formatNumber(LIFECYCLE_LIST_LIMIT),
            })}
          </Notice>
        </div>
      ) : null}

      {openRow !== null ? (
        <RehirePanel row={openRow} onClose={() => setParam("open", "")} />
      ) : null}

      <div className="mt-4">
        <StateBoundary
          loading={register.isPending}
          error={register.error}
          onRetry={() => void register.refetch()}
          isEmpty={rows.length === 0}
          partialError={listTotal.error}
          partialLabel={t("admin.rehire.partial.total")}
          empty={
            <EmptyState
              icon={Users}
              title={t("admin.rehire.empty.title")}
              hint={t("admin.rehire.empty.hint")}
              {...(hasFilter
                ? {
                    action: (
                      <Button variant="outline" onClick={clearAll}>
                        {t("admin.rehire.filter.clear")}
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

      <h2 className="mt-8 font-display text-lg font-semibold">{t("admin.rehire.event.title")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("admin.rehire.event.hint")}</p>

      <div className="mt-3">
        <StateBoundary
          loading={rehires.isPending}
          error={rehires.error}
          onRetry={() => void rehires.refetch()}
          isEmpty={rehireRows.length === 0}
          partialError={labels.error}
          partialLabel={t("admin.rehire.event.partial.names")}
          skeletonRows={2}
          empty={
            <EmptyState
              icon={UserCheck}
              title={t("admin.rehire.event.empty.title")}
              hint={t("admin.rehire.event.empty.hint")}
            />
          }
        >
          <DataGrid
            columns={rehireColumns}
            rows={rehireRows}
            rowKey={(r) => r.id}
            pageSize={50}
          />
        </StateBoundary>
      </div>
      <ReasonDialog
        open={prompt.isOpen}
        title={t("admin.rehire.dialog.title", {
          name: prompt.target?.employee.display_name ?? "",
        })}
        description={t("admin.rehire.dialog.description")}
        minLength={SENSITIVE_REASON_LENGTH}
        confirmLabel={t("admin.rehire.dialog.cta")}
        pending={rehire.isPending}
        errorMessage={rehire.userMessage}
        onConfirm={(reason) => {
          const target = prompt.target;
          if (target === null || actorProfileId === null) return;
          rehire.save(
            {
              employeeId: target.employee.id,
              eventType: "rehired",
              /* Today: a rehire takes effect when it is decided. Backdating it
                 would rewrite the status of days they were not employed for. */
              effectiveDate: nowIstDate(),
              recordedBy: actorProfileId,
            },
            reason,
          );
          prompt.close();
        }}
        onCancel={() => {
          prompt.close();
        }}
      />
    </div>
  );
}

/** A tile whose number is a Postgres COUNT over the slice it opens. */
function Tile({
  label,
  hint,
  query,
  onClick,
}: {
  label: string;
  hint: string;
  query: { data: number | undefined; error: Error | null; isPending: boolean };
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="num mt-1 font-display text-2xl font-semibold">
        {query.isPending ? "…" : query.error !== null ? t("common.empty") : formatNumber(query.data)}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </button>
  );
}

/** One labelled server value. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="num truncate text-sm">{value}</dd>
    </div>
  );
}

/**
 * One former employee: their service as the record holds it, and the one thing an
 * admin may decide here. The reason floor is 15 characters because "eligible" and
 * "not eligible" are read back years later by someone deciding a shortlist.
 */
function RehirePanel({ row, onClose }: { row: LifecycleEmployee; onClose: () => void }) {
  const update = useLifecycleEmployeeUpdate(row.employee_code);

  async function decide(value: boolean, reason: string): Promise<void> {
    await update.saveAsync(
      {
        employeeId: row.id,
        patch: { is_rehire_eligible: value },
        expectedUpdatedAt: row.updated_at,
      },
      reason,
    );
  }

  return (
    <section className="mt-4 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold">{t("admin.rehire.panel.title")}</h2>
          <PersonCell
            name={row.display_name}
            code={row.employee_code}
            secondary={row.designation_name}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to={`/admin/people/${encodeURIComponent(row.employee_code)}`}>
              {t("admin.rehire.panel.openPerson")}
            </Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link to={`/admin/people/${encodeURIComponent(row.employee_code)}/audit`}>
              {t("admin.rehire.panel.openHistory")}
            </Link>
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="mr-1 size-4" aria-hidden />
            {t("admin.rehire.panel.close")}
          </Button>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
        <Fact label={t("admin.rehire.col.joined")} value={fmtCivilDate(row.date_of_join)} />
        <Fact label={t("admin.rehire.col.left")} value={fmtCivilDate(row.last_working_day)} />
        <Fact
          label={t("admin.rehire.fact.exitType")}
          value={row.exit_type === null ? t("admin.rehire.noExitType") : EXIT_TYPE_CHIP[row.exit_type]?.label ?? dash(row.exit_type)}
        />
        <Fact
          label={t("admin.rehire.col.settled")}
          value={fmtCivilDate(row.full_and_final_settled_on)}
        />
        <Fact label={t("admin.rehire.fact.department")} value={dash(row.department_name)} />
        <Fact label={t("admin.rehire.fact.designation")} value={dash(row.designation_name)} />
        <Fact label={t("admin.rehire.fact.manager")} value={dash(row.reporting_manager_name)} />
        <Fact
          label={t("admin.rehire.fact.interview")}
          value={
            row.exit_interview_done
              ? t("admin.rehire.fact.interviewDone")
              : t("admin.rehire.fact.interviewNotDone")
          }
        />
      </dl>

      {row.exit_reason === null ? null : (
        <div className="mt-3">
          <p className="text-xs text-muted-foreground">{t("admin.rehire.fact.exitReason")}</p>
          <p className="text-sm">{row.exit_reason}</p>
        </div>
      )}

      {update.userMessage !== null ? (
        <div className="mt-3">
          <Notice tone="error">{update.userMessage}</Notice>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <ReasonActionButton
          label={t("admin.rehire.action.eligible")}
          title={t("admin.rehire.action.eligibleTitle")}
          description={t("admin.rehire.action.description", {
            name: row.display_name,
            code: row.employee_code,
            value: t("admin.rehire.decision.eligibleShort"),
          })}
          confirmLabel={t("admin.rehire.action.confirm")}
          minLength={15}
          variant="default"
          size="default"
          disabled={row.is_rehire_eligible === true || update.isPending}
          disabledHint={t("admin.rehire.action.disabled")}
          onConfirm={(reason) => decide(true, reason)}
        />
        <ReasonActionButton
          label={t("admin.rehire.action.notEligible")}
          title={t("admin.rehire.action.notEligibleTitle")}
          description={t("admin.rehire.action.description", {
            name: row.display_name,
            code: row.employee_code,
            value: t("admin.rehire.decision.notEligibleShort"),
          })}
          confirmLabel={t("admin.rehire.action.confirm")}
          minLength={15}
          size="default"
          disabled={row.is_rehire_eligible === false || update.isPending}
          disabledHint={t("admin.rehire.action.disabled")}
          onConfirm={(reason) => decide(false, reason)}
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t("admin.rehire.action.footnote")}</p>

      <div className="mt-4">
        <Notice tone="info">{t("admin.rehire.panel.reactivateNotice")}</Notice>
      </div>
    </section>
  );
}
