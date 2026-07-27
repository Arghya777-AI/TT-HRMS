/**
 * §12 · /admin/workflow/designer — Workflow Designer. Approval chains as data,
 * not code.
 *
 * This screen READS the routing configuration and does not write it, and that is
 * a property of the database rather than a shortcut. Migration 029 puts the
 * engine's own words on it: status and level "are engine-owned (SECURITY DEFINER
 * RPCs)", and while `approval_chains` / `approval_chain_levels` do carry an
 * admin write policy, there is NO server-side validator for a chain edit — no
 * function that checks the level sequence has no hole, that `min_approvals`
 * cannot exceed the number of people a kind resolves to, that a band does not
 * overlap a sibling chain's, or that the chain a live request is mid-way through
 * is not being renumbered underneath it. `create_approval_request` resolves the
 * chain ONCE, at submission, and `advance_approval` then walks the levels of a
 * chain it assumes is stable. An editor here would therefore be a form that can
 * silently strand in-flight requests, which is worse than no editor.
 *
 * So what it does instead is EXPLAIN the routing exactly as the engine reads it:
 *
 *  * Chains are listed in resolution order — `priority` ascending, then
 *    `sort_order` — because that is the order `create_approval_request` picks
 *    from, and "which chain will this request take?" is the question this screen
 *    exists to answer.
 *  * The selector band is printed in words (`amount_from/to` are numeric RUPEES
 *    here, `days_from/to` are days), together with the department, grade and
 *    employment-type predicates, so a chain that never matches anything is
 *    visible as such.
 *  * Every level shows its approver kind, how many approvals it needs, whether
 *    it is optional or notify-only, whether it may edit the request, its own SLA
 *    override, and where it escalates when `sla_sweep` finds it late.
 *  * `skip_if_same_as_previous` is called out in words, because it is the reason
 *    a manager's own leave request does not stall waiting for the manager.
 *
 * Nothing is computed: level counts come from the rows Postgres returned for that
 * chain, and the chain total is a `count=exact` over the same predicate as the
 * list.
 *
 * @route /admin/workflow/designer
 */
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { fmtDateTime, fmtDurationFromHours } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { SelectField } from "../components/Field";
import { useRefOptions } from "../hooks/useMasters";
import { amountBandLabel, approverKindLabel, daysBandLabel, roleLabel } from "../workflow-vocab";
import { EMPLOYMENT_TYPE_LABELS } from "../api/employees.api";
import type { ApprovalChain, ApprovalChainLevel } from "../api/workflow-admin.api";
import {
  useApprovalChainCount,
  useApprovalChains,
  useChainLevels,
  usePeopleByEmployeeId,
  useRequestTypeMap,
  useRequestTypes,
  type PersonRefMap,
} from "../hooks/useWorkflowAdmin";

const CHAIN_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  default: { label: t("admin.wf.designer.chip.default"), tone: "success" },
  alternate: { label: t("admin.wf.designer.chip.alternate"), tone: "info" },
  inactive: { label: t("admin.wf.designer.chip.inactive"), tone: "neutral" },
};

function chainState(chain: ApprovalChain): string {
  if (!chain.is_active) return "inactive";
  return chain.is_default ? "default" : "alternate";
}

/**
 * `applies_to_employment_types` is a `public.employment_type[]`. The wording is
 * the directory's existing catalogue, not a second one: an employment type has to
 * read identically on the chain that routes it and on the person it applies to.
 */
const EMPLOYMENT_TYPE_LABEL: ReadonlyMap<string, string> = new Map(
  Object.entries(EMPLOYMENT_TYPE_LABELS),
);

/** ids → names, or the count when a name is not in the loaded reference list. */
function namesOf(
  ids: readonly string[] | null,
  lookup: ReadonlyMap<string, string>,
  noneLabel: string,
): string {
  if (ids === null || ids.length === 0) return noneLabel;
  const named = ids.map((id) => lookup.get(id)).filter((v): v is string => v !== undefined);
  if (named.length === 0) return t("admin.wf.designer.nIds", { n: formatNumber(ids.length) });
  return named.join(", ");
}

export default function WorkflowDesignerPage() {
  const [params, setParams] = useSearchParams();
  const requestTypeId = params.get("type") ?? "";
  const includeInactive = params.get("inactive") === "1";
  const openChainId = params.get("chain") ?? "";

  const types = useRequestTypes();
  const typeMap = useRequestTypeMap(types.data);
  const departments = useRefOptions("departments");
  const grades = useRefOptions("grades");

  const filters = useMemo(
    () => ({
      ...(requestTypeId !== "" ? { requestTypeId } : {}),
      ...(includeInactive ? { includeInactive: true } : {}),
    }),
    [requestTypeId, includeInactive],
  );

  const chains = useApprovalChains(filters);
  const total = useApprovalChainCount(filters);
  // Memoised: the chain-id list below feeds a query key.
  const rows = useMemo(() => chains.data ?? [], [chains.data]);

  const chainIds = useMemo(() => rows.map((c) => c.id), [rows]);
  const levels = useChainLevels(chainIds);

  // A `specific_employee` level names a person; that is a join, not a lookup list.
  const specificIds = useMemo(
    () =>
      (levels.data?.levels ?? [])
        .map((l) => l.specific_employee_id)
        .filter((v): v is string => v !== null),
    [levels.data],
  );
  const people = usePeopleByEmployeeId(specificIds);

  const departmentNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of departments.data ?? []) map.set(d.id, d.name);
    return map as ReadonlyMap<string, string>;
  }, [departments.data]);

  const gradeNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of grades.data ?? []) map.set(g.id, g.name);
    return map as ReadonlyMap<string, string>;
  }, [grades.data]);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  return (
    <div className="container py-6">
      <PageHeader
        icon={Workflow}
        title={t("admin.wf.designer.title")}
        subtitle={
          total.isSuccess
            ? t("admin.wf.designer.subtitle.count", { n: formatNumber(total.data) })
            : t("admin.wf.designer.subtitle.plain")
        }
      />

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-3">
        <SelectField
          label={t("admin.wf.designer.filter.type")}
          value={requestTypeId}
          placeholder={t("admin.wf.designer.filter.anyType")}
          options={(types.data ?? []).map((rt) => ({ value: rt.id, label: rt.name }))}
          onChange={(v) => setParam("type", v)}
          hint={t("admin.wf.designer.filter.typeHint")}
        />
        <div className="flex items-end gap-2">
          <Button
            type="button"
            variant={includeInactive ? "default" : "outline"}
            aria-pressed={includeInactive}
            onClick={() => setParam("inactive", includeInactive ? "" : "1")}
          >
            {t("admin.wf.designer.filter.includeInactive")}
          </Button>
          {requestTypeId !== "" || includeInactive ? (
            <Button
              variant="ghost"
              onClick={() => setParams(new URLSearchParams(), { replace: true })}
            >
              {t("admin.wf.designer.filter.clear")}
            </Button>
          ) : null}
        </div>
        <div className="flex items-end justify-end">
          <p className="text-sm text-muted-foreground">
            {t("admin.wf.designer.resolutionOrder")}
          </p>
        </div>
      </div>

      <div className="mt-4">
        <StateBoundary
          loading={chains.isPending}
          error={chains.error}
          onRetry={() => void chains.refetch()}
          isEmpty={rows.length === 0}
          partialError={levels.error ?? total.error}
          partialLabel={t("admin.wf.designer.partial")}
          empty={
            <EmptyState
              icon={Workflow}
              title={t("admin.wf.designer.empty.title")}
              hint={t("admin.wf.designer.empty.hint")}
            />
          }
        >
          <div className="space-y-4">
            {rows.map((chain) => {
              const chainLevels = levels.data?.byChain.get(chain.id) ?? [];
              const open = openChainId === chain.id;
              const typeName =
                chain.request_type_id === null
                  ? null
                  : typeMap.get(chain.request_type_id)?.name ?? null;
              const requestType =
                chain.request_type_id === null ? null : typeMap.get(chain.request_type_id) ?? null;
              return (
                <section key={chain.id} className="rounded-lg border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="flex flex-wrap items-center gap-2 font-display text-lg font-semibold">
                        {chain.name}
                        <StatusChip status={chainState(chain)} map={CHAIN_CHIP} />
                      </h2>
                      <p className="num text-xs text-muted-foreground">{chain.code}</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {t("admin.wf.designer.forType", {
                          type: typeName ?? t("admin.wf.designer.anyRequestType"),
                        })}
                      </p>
                      {chain.description !== null ? (
                        <p className="mt-1 text-sm">{chain.description}</p>
                      ) : null}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setParam("chain", open ? "" : chain.id)}
                      aria-expanded={open}
                    >
                      {open
                        ? t("admin.wf.designer.hideLevels")
                        : t("admin.wf.designer.showLevels", {
                            n: formatNumber(chainLevels.length),
                          })}
                    </Button>
                  </div>

                  <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Fact
                      label={t("admin.wf.designer.fact.amountBand")}
                      value={amountBandLabel(chain.amount_from, chain.amount_to)}
                    />
                    <Fact
                      label={t("admin.wf.designer.fact.daysBand")}
                      value={daysBandLabel(chain.days_from, chain.days_to)}
                    />
                    <Fact
                      label={t("admin.wf.designer.fact.departments")}
                      value={namesOf(
                        chain.applies_to_department_ids,
                        departmentNames,
                        t("admin.wf.designer.allDepartments"),
                      )}
                    />
                    <Fact
                      label={t("admin.wf.designer.fact.grades")}
                      value={namesOf(
                        chain.applies_to_grade_ids,
                        gradeNames,
                        t("admin.wf.designer.allGrades"),
                      )}
                    />
                    <Fact
                      label={t("admin.wf.designer.fact.employmentTypes")}
                      value={
                        chain.applies_to_employment_types === null ||
                        chain.applies_to_employment_types.length === 0
                          ? t("admin.wf.designer.allEmploymentTypes")
                          : chain.applies_to_employment_types
                              .map((v) => EMPLOYMENT_TYPE_LABEL.get(v) ?? v)
                              .join(", ")
                      }
                    />
                    <Fact
                      label={t("admin.wf.designer.fact.priority")}
                      value={formatNumber(chain.priority)}
                    />
                    <Fact
                      label={t("admin.wf.designer.fact.typeSla")}
                      value={
                        requestType === null
                          ? dash(null)
                          : fmtDurationFromHours(requestType.sla_hours)
                      }
                    />
                    <Fact
                      label={t("admin.wf.designer.fact.updated")}
                      value={fmtDateTime(chain.updated_at)}
                    />
                  </dl>

                  {open ? (
                    <div className="mt-4">
                      {chainLevels.length === 0 ? (
                        <Notice tone="warning">{t("admin.wf.designer.noLevels")}</Notice>
                      ) : (
                        <DataGrid
                          columns={levelColumns(people.data)}
                          rows={chainLevels}
                          rowKey={(l) => l.id}
                          pageSize={10}
                        />
                      )}
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
        </StateBoundary>
      </div>

      <div className="mt-4">
        <Notice tone="info">{t("admin.wf.designer.readOnlyNotice")}</Notice>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background p-3">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm font-medium">{value}</dd>
    </div>
  );
}

/**
 * One row per level, in the order `advance_approval` walks them.
 *
 * `sla_hours` on a level OVERRIDES the request type's; when it is null the type's
 * figure applies, and the cell says which of the two it is showing rather than
 * printing a bare number that means different things in different rows.
 */
function levelColumns(
  people: PersonRefMap | undefined,
): DataGridColumn<ApprovalChainLevel>[] {
  return [
    {
      key: "level",
      header: t("admin.wf.designer.col.level"),
      width: "5rem",
      align: "right",
      render: (l) => <span className="num font-medium">{formatNumber(l.level)}</span>,
    },
    {
      key: "approver_kind",
      header: t("admin.wf.designer.col.approver"),
      width: "16rem",
      render: (l) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium">{approverKindLabel(l.approver_kind)}</span>
          {l.specific_employee_id !== null ? (
            <span className="text-xs text-muted-foreground">
              {dash(people?.get(l.specific_employee_id)?.display_name ?? null)}
            </span>
          ) : null}
          {l.role !== null ? (
            <span className="text-xs text-muted-foreground">
              {t("admin.wf.designer.roleIs", { role: roleLabel(l.role) })}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "min_approvals",
      header: t("admin.wf.designer.col.needs"),
      width: "9rem",
      align: "right",
      render: (l) => (
        <span className="num">
          {t("admin.wf.designer.needsN", { n: formatNumber(l.min_approvals) })}
        </span>
      ),
    },
    {
      key: "sla_hours",
      header: t("admin.wf.designer.col.levelSla"),
      width: "10rem",
      align: "right",
      render: (l) =>
        l.sla_hours === null ? (
          <span className="text-xs text-muted-foreground">
            {t("admin.wf.designer.slaFromType")}
          </span>
        ) : (
          <span className="num">{fmtDurationFromHours(l.sla_hours)}</span>
        ),
    },
    {
      key: "escalate_to_kind",
      header: t("admin.wf.designer.col.escalatesTo"),
      width: "13rem",
      render: (l) =>
        l.escalate_to_kind === null ? (
          <span className="text-xs text-muted-foreground">
            {t("admin.wf.designer.noEscalation")}
          </span>
        ) : (
          approverKindLabel(l.escalate_to_kind)
        ),
    },
    {
      key: "flags",
      header: t("admin.wf.designer.col.behaviour"),
      render: (l) => {
        const flags = [
          l.is_optional ? t("admin.wf.designer.flag.optional") : null,
          l.notify_only ? t("admin.wf.designer.flag.notifyOnly") : null,
          l.can_edit_request ? t("admin.wf.designer.flag.canEdit") : null,
          l.skip_if_same_as_previous ? t("admin.wf.designer.flag.skipIfSame") : null,
        ].filter((v): v is string => v !== null);
        return flags.length === 0 ? (
          <span className="text-xs text-muted-foreground">{t("admin.wf.designer.flag.none")}</span>
        ) : (
          <span className="text-xs text-muted-foreground">{flags.join(" · ")}</span>
        );
      },
    },
  ];
}
