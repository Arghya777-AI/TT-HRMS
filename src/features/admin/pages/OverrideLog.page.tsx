/**
 * §12 · /admin/workflow/overrides — Override Log. Every time a rule was
 * deliberately overridden.
 *
 * The rows are `approval_actions` — the approvals engine's append-only trail. It
 * has NO UPDATE and NO DELETE policy for anyone, and `audit.refuse_mutation()`
 * refuses both regardless, so this register can only ever grow. That is what
 * makes it evidence rather than a log that could have been tidied, and the page
 * says so instead of assuming the reader knows.
 *
 * WHY THE "KIND" IS ONE SELECT AND NOT A SET OF CHECKBOXES. "Deliberately
 * overridden" is not one column. Three of the five kinds live in `acted_as` (HOW
 * the actor held their authority) and two live in `action` (WHAT the engine did),
 * and the sanctioned query layer has no OR — by design, because an OR needs raw
 * PostgREST syntax. So rather than offer a "show everything unusual" filter that
 * silently searches one column, the screen makes the reader pick the dimension
 * and states what each choice means:
 *
 *  * Administrative override — `acted_as = 'admin_override'`, stamped by
 *    `act_on_approval` when the actor was NOT in `current_approver_ids` and IS an
 *    admin. This is the one that reaches past a named approver, and an admin
 *    override "always satisfies the level" — the request moves on immediately.
 *  * Acted as delegate — `acted_as = 'delegate'`: authority borrowed through
 *    `delegations`. `delegated_from` names whose it was.
 *  * Escalation — `acted_as = 'escalation'`, written by `sla_sweep()` with a NULL
 *    actor when a level breached its SLA. Attributed to the system, never blank.
 *  * Level skipped — `action = 'skip_level'`, recorded by `advance_approval` when
 *    a level was optional or `skip_if_same_as_previous` applied (the reason a
 *    manager's own request does not wait for the manager).
 *  * Auto-approved — `action = 'auto_approve'`, from the sweep when a request
 *    type's `auto_approve_after_hours` elapsed. Every request type at Tamarind
 *    Tree leaves that column NULL — silence is not consent — so this slice
 *    reading zero is the configuration being confirmed, not a gap.
 *
 * The date window filters `acted_at`, a `timestamptz`, through
 * `istRangeInstantBounds` — comparing it against a bare 'YYYY-MM-DD' would pin
 * the bound to 05:30 IST and quietly drop the first five and a half hours of
 * every day.
 *
 * @route /admin/workflow/overrides
 */
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtDateTime, nowIstDate } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField, TextField } from "../components/Field";
import {
  ACTED_AS_CHIP,
  REQUEST_STATUS_CHIP,
  actionLabel,
  roleLabel,
} from "../workflow-vocab";
import {
  isOverrideKind,
  overrideKindValues,
  type OverrideAction,
  type OverrideFilters,
  type OverrideKind,
  type RequestRef,
} from "../api/workflow-admin.api";
import {
  flattenOverrides,
  useOverrideActions,
  useOverrideCount,
  usePeopleByProfileId,
  useRequestRefs,
  useRequestTypeMap,
  useRequestTypes,
  type PersonRefMap,
  type RequestTypeMap,
} from "../hooks/useWorkflowAdmin";

const KIND_LABEL: Readonly<Record<OverrideKind, string>> = {
  admin_override: t("admin.wf.ovr.kind.adminOverride"),
  delegate: t("admin.wf.ovr.kind.delegate"),
  escalation: t("admin.wf.ovr.kind.escalation"),
  skip_level: t("admin.wf.ovr.kind.skipLevel"),
  auto_approve: t("admin.wf.ovr.kind.autoApprove"),
};

const KIND_HINT: Readonly<Record<OverrideKind, string>> = {
  admin_override: t("admin.wf.ovr.hint.adminOverride"),
  delegate: t("admin.wf.ovr.hint.delegate"),
  escalation: t("admin.wf.ovr.hint.escalation"),
  skip_level: t("admin.wf.ovr.hint.skipLevel"),
  auto_approve: t("admin.wf.ovr.hint.autoApprove"),
};

export default function OverrideLogPage() {
  const [params, setParams] = useSearchParams();
  const rawKind = params.get("kind");
  const kind: OverrideKind = isOverrideKind(rawKind) ? rawKind : "admin_override";
  const today = nowIstDate();
  const fromDate = params.get("from") ?? "";
  const toDate = params.get("to") ?? "";
  const windowSet = fromDate !== "" && toDate !== "";

  const types = useRequestTypes();
  const typeMap = useRequestTypeMap(types.data);

  const filters = useMemo<OverrideFilters>(
    () => ({
      kind,
      ...(windowSet ? { fromDate, toDate } : {}),
    }),
    [kind, windowSet, fromDate, toDate],
  );

  const list = useOverrideActions(filters);
  const rows = flattenOverrides(list.data);
  const total = useOverrideCount(filters);

  const profileIds = useMemo(
    () =>
      rows
        .flatMap((r) => [r.actor_id, r.delegated_from])
        .filter((v): v is string => v !== null),
    [rows],
  );
  const people = usePeopleByProfileId(profileIds);

  const requestIds = useMemo(() => rows.map((r) => r.approval_request_id), [rows]);
  const requests = useRequestRefs(requestIds);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const anyFilter = kind !== "admin_override" || fromDate !== "" || toDate !== "";

  return (
    <div className="container py-6">
      <PageHeader
        icon={ShieldCheck}
        title={t("admin.wf.ovr.title")}
        subtitle={
          total.isSuccess
            ? t("admin.wf.ovr.subtitle.count", {
                n: formatNumber(total.data),
                kind: KIND_LABEL[kind],
              })
            : t("admin.wf.ovr.subtitle.plain")
        }
      />

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <SelectField
          label={t("admin.wf.ovr.filter.kind")}
          value={kind}
          options={overrideKindValues.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
          onChange={(v) => setParam("kind", v)}
          hint={t("admin.wf.ovr.filter.kindHint")}
        />
        <TextField
          label={t("admin.wf.ovr.filter.from")}
          type="date"
          value={fromDate}
          max={toDate !== "" ? toDate : today}
          onChange={(v) => setParam("from", v)}
        />
        <TextField
          label={t("admin.wf.ovr.filter.to")}
          type="date"
          value={toDate}
          max={today}
          {...(fromDate !== "" ? { min: fromDate } : {})}
          onChange={(v) => setParam("to", v)}
          {...(fromDate !== "" && toDate === ""
            ? { hint: t("admin.wf.ovr.filter.needBoth") }
            : {})}
        />
        <div className="flex items-end gap-2">
          {anyFilter ? (
            <Button
              variant="ghost"
              onClick={() => setParams(new URLSearchParams(), { replace: true })}
            >
              {t("admin.wf.ovr.filter.clear")}
            </Button>
          ) : null}
        </div>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">{KIND_HINT[kind]}</p>

      <div className="mt-4">
        <StateBoundary
          loading={list.isPending}
          error={list.error}
          onRetry={() => void list.refetch()}
          isEmpty={rows.length === 0}
          partialError={people.error ?? requests.error ?? total.error}
          partialLabel={t("admin.wf.ovr.partial")}
          empty={
            <EmptyState
              icon={ShieldCheck}
              title={t("admin.wf.ovr.empty.title", { kind: KIND_LABEL[kind] })}
              hint={
                kind === "auto_approve"
                  ? t("admin.wf.ovr.empty.hintAutoApprove")
                  : t("admin.wf.ovr.empty.hint")
              }
              {...(anyFilter
                ? {
                    action: (
                      <Button
                        variant="outline"
                        onClick={() => setParams(new URLSearchParams(), { replace: true })}
                      >
                        {t("admin.wf.ovr.filter.clear")}
                      </Button>
                    ),
                  }
                : {})}
            />
          }
        >
          <DataGrid
            columns={overrideColumns(people.data, requests.data, typeMap)}
            rows={rows}
            rowKey={(row) => row.id}
            pageSize={25}
          />

          {list.hasNextPage ? (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                onClick={() => void list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
              >
                {list.isFetchingNextPage
                  ? t("admin.wf.ovr.loadingMore")
                  : t("admin.wf.ovr.loadMore")}
              </Button>
            </div>
          ) : null}
        </StateBoundary>
      </div>

      <div className="mt-4 space-y-3">
        <Notice tone="info">{t("admin.wf.ovr.appendOnlyNotice")}</Notice>
        <Notice tone="info">{t("admin.wf.ovr.scopeNotice")}</Notice>
      </div>
    </div>
  );
}

function overrideColumns(
  people: PersonRefMap | undefined,
  requests: ReadonlyMap<string, RequestRef> | undefined,
  typeMap: RequestTypeMap,
): DataGridColumn<OverrideAction>[] {
  return [
    {
      key: "acted_at",
      header: t("admin.wf.ovr.col.when"),
      width: "12rem",
      sortable: true,
      render: (row) => <span className="num">{fmtDateTime(row.acted_at)}</span>,
    },
    {
      key: "approval_request_id",
      header: t("admin.wf.ovr.col.request"),
      width: "16rem",
      render: (row) => {
        const ref = requests?.get(row.approval_request_id) ?? null;
        return ref === null ? (
          <span className="text-sm text-muted-foreground">{t("admin.wf.ovr.requestUnread")}</span>
        ) : (
          <span className="flex flex-col leading-tight">
            <span className="font-medium">{ref.title}</span>
            <span className="num text-xs text-muted-foreground">
              {ref.request_number}
              {" · "}
              {dash(typeMap.get(ref.request_type_id)?.name ?? null)}
            </span>
          </span>
        );
      },
    },
    {
      key: "action",
      header: t("admin.wf.ovr.col.what"),
      width: "10rem",
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium">{actionLabel(row.action)}</span>
          <span className="text-xs text-muted-foreground">
            {t("admin.wf.ovr.atLevel", { level: formatNumber(row.level) })}
          </span>
        </span>
      ),
    },
    {
      key: "actor_id",
      header: t("admin.wf.ovr.col.who"),
      width: "14rem",
      render: (row) => {
        if (row.actor_id === null) {
          return (
            <span className="flex flex-col leading-tight">
              <span className="text-sm font-medium">{t("admin.wf.ovr.system")}</span>
              <span className="text-xs text-muted-foreground">{t("admin.wf.ovr.systemHint")}</span>
            </span>
          );
        }
        const person = people?.get(row.actor_id) ?? null;
        return person === null ? (
          <span className="text-sm text-muted-foreground">{dash(null)}</span>
        ) : (
          <PersonCell
            name={person.display_name}
            code={person.employee_code}
            secondary={roleLabel(row.actor_role)}
          />
        );
      },
    },
    {
      key: "acted_as",
      header: t("admin.wf.ovr.col.authority"),
      width: "12rem",
      render: (row) => (
        <span className="flex flex-col gap-1 leading-tight">
          {row.acted_as === null ? (
            <span className="text-xs text-muted-foreground">{t("admin.wf.ovr.noActedAs")}</span>
          ) : (
            <StatusChip status={row.acted_as} map={ACTED_AS_CHIP} />
          )}
          {row.delegated_from !== null ? (
            <span className="text-xs text-muted-foreground">
              {t("admin.wf.ovr.delegatedFrom", {
                name: dash(people?.get(row.delegated_from)?.display_name ?? null),
              })}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "request_status",
      header: t("admin.wf.ovr.col.requestState"),
      width: "10rem",
      hideBelow: "lg",
      render: (row) => {
        const ref = requests?.get(row.approval_request_id) ?? null;
        return ref === null ? (
          <span className="text-sm text-muted-foreground">{dash(null)}</span>
        ) : (
          <StatusChip status={ref.status} map={REQUEST_STATUS_CHIP} />
        );
      },
    },
    {
      key: "comment",
      header: t("admin.wf.ovr.col.reason"),
      render: (row) => (
        <span className="whitespace-pre-line text-sm">{dash(row.comment)}</span>
      ),
    },
  ];
}
