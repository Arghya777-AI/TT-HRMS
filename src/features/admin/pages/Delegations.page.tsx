/**
 * §12 · /admin/workflow/delegations — Delegations. Temporary transfer of
 * approval authority.
 *
 * The venue reason this table exists: an F&B manager is on the floor for a
 * twelve-hour wedding and their reportees' leave and regularisation requests
 * cannot sit still for a day. `delegations` is how that hand-over is DATA rather
 * than a WhatsApp message — and `resolve_approvers(..., p_expand_delegations =>
 * true)` reads it every time a request is routed, so a row here changes who the
 * engine puts in `current_approver_ids`.
 *
 * What this console shows, and why each part is worded the way it is:
 *
 *  * FLAGGED ACTIVE ≠ IN FORCE TODAY. `is_active` is a flag; the RPC ALSO
 *    requires `CURRENT_DATE BETWEEN from_date AND COALESCE(to_date,
 *    CURRENT_DATE)`. A row flagged active whose window starts next Tuesday is not
 *    routing anything yet. Both facts are printed separately and never merged
 *    into one green word — the "in force" reading is the SERVER'S date test
 *    described in words, not a comparison this page makes.
 *  * DEPTH IS ONE, BY TRIGGER. `delegations_guard()` refuses a delegate who is
 *    already a delegator (and vice versa) over an overlapping window, and refuses
 *    an overlapping delegation for the same delegator and request type. So a
 *    chain of hand-overs cannot exist, and the screen says so rather than
 *    implying it could.
 *  * SCOPE IS TWO VALUES. `approvals` or `approvals_and_team_view` — the second
 *    also lends the delegate the team's attendance/leave visibility, which is a
 *    data-access grant, so it is chipped distinctly.
 *  * ENDING ONE IS THE ONLY WRITE ON THESE FIVE SCREENS, and it flips
 *    `is_active` only. Dates are history: narrowing `to_date` after the fact
 *    would rewrite the window under which decisions were already taken, and
 *    `approval_actions.delegated_from` still points at them. Creating a
 *    delegation is deliberately NOT here — `delegations__own_insert` is written
 *    for the DELEGATOR (`delegator_profile_id = app.ctx_actor_id() OR
 *    app.is_admin()`), and an admin-composed hand-over of somebody else's
 *    authority needs the manager's own confirmation, which this console has no
 *    way to obtain.
 *
 * The two ends of a delegation are `profiles.id`; names come from
 * `v_employee_ref` (a join, keyed by the ids already on screen), because
 * `profiles` itself is self-read only.
 *
 * @route /admin/workflow/delegations
 */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { SENSITIVE_REASON_LENGTH } from "@/shared/api/query";
import { fmtCivilDate } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField } from "../components/Field";
import { useReasonPrompt } from "../hooks/useReasonPrompt";
import { delegationScopeLabel } from "../workflow-vocab";
import {
  delegationScopeValues,
  isDelegationSlice,
  type Delegation,
  type DelegationFilters,
  type DelegationScope,
  type DelegationSlice,
} from "../api/workflow-admin.api";
import {
  useDelegationCount,
  useDelegations,
  useEndDelegation,
  usePeopleByProfileId,
  useRequestTypeMap,
  useRequestTypes,
  type PersonRefMap,
  type RequestTypeMap,
} from "../hooks/useWorkflowAdmin";

const FLAG_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  active: { label: t("admin.wf.deleg.flag.active"), tone: "success" },
  ended: { label: t("admin.wf.deleg.flag.ended"), tone: "neutral" },
};

const SCOPE_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  approvals: { label: t("admin.wf.deleg.scope.approvals"), tone: "info" },
  approvals_and_team_view: {
    label: t("admin.wf.deleg.scope.approvalsAndTeamView"),
    tone: "warn",
  },
};

const TILES: readonly { slice: DelegationSlice; label: string; ring: string }[] = [
  { slice: "active", label: t("admin.wf.deleg.tile.active"), ring: "border-success/50" },
  { slice: "ended", label: t("admin.wf.deleg.tile.ended"), ring: "border-border" },
  { slice: "all", label: t("admin.wf.deleg.tile.all"), ring: "border-info/50" },
];

function isScope(value: string): value is DelegationScope {
  return (delegationScopeValues as readonly string[]).includes(value);
}

export default function DelegationsPage() {
  const [params, setParams] = useSearchParams();
  const rawSlice = params.get("slice");
  const slice: DelegationSlice = isDelegationSlice(rawSlice) ? rawSlice : "active";
  const rawScope = params.get("scope") ?? "";
  const scope = isScope(rawScope) ? rawScope : undefined;
  const requestTypeId = params.get("type") ?? "";

  const [ended, setEnded] = useState<Delegation | null>(null);
  const prompt = useReasonPrompt<Delegation>();

  const types = useRequestTypes();
  const typeMap = useRequestTypeMap(types.data);

  const filters = useMemo<DelegationFilters>(
    () => ({
      slice,
      ...(scope !== undefined ? { scope } : {}),
      ...(requestTypeId !== "" ? { requestTypeId } : {}),
    }),
    [slice, scope, requestTypeId],
  );

  const list = useDelegations(filters);
  // Memoised so the id-collecting `useMemo`s below do not see a new array
  // (and refetch the name joins) on every render.
  const rows = useMemo(() => list.data ?? [], [list.data]);
  const total = useDelegationCount(filters);

  const counts: Record<DelegationSlice, ReturnType<typeof useDelegationCount>> = {
    active: useDelegationCount({ ...filters, slice: "active" }),
    ended: useDelegationCount({ ...filters, slice: "ended" }),
    all: useDelegationCount({ ...filters, slice: "all" }),
  };

  const profileIds = useMemo(
    () => rows.flatMap((r) => [r.delegator_profile_id, r.delegate_profile_id]),
    [rows],
  );
  const people = usePeopleByProfileId(profileIds);

  const end = useEndDelegation((row) => {
    setEnded(row);
    prompt.close();
  });

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const columns: DataGridColumn<Delegation>[] = [
    {
      key: "delegator_profile_id",
      header: t("admin.wf.deleg.col.from"),
      width: "14rem",
      render: (row) => <PersonOrId profileId={row.delegator_profile_id} people={people.data} />,
    },
    {
      key: "delegate_profile_id",
      header: t("admin.wf.deleg.col.to"),
      width: "14rem",
      render: (row) => <PersonOrId profileId={row.delegate_profile_id} people={people.data} />,
    },
    {
      key: "from_date",
      header: t("admin.wf.deleg.col.window"),
      width: "15rem",
      sortable: true,
      render: (row) => (
        <span className="num text-sm">
          {row.to_date === null
            ? t("admin.wf.deleg.openEnded", { from: fmtCivilDate(row.from_date) })
            : t("admin.wf.deleg.window", {
                from: fmtCivilDate(row.from_date),
                to: fmtCivilDate(row.to_date),
              })}
        </span>
      ),
    },
    {
      key: "scope",
      header: t("admin.wf.deleg.col.scope"),
      width: "13rem",
      render: (row) => <StatusChip status={row.scope} map={SCOPE_CHIP} />,
    },
    {
      key: "request_type_ids",
      header: t("admin.wf.deleg.col.types"),
      hideBelow: "lg",
      render: (row) => (
        <span className="text-sm text-muted-foreground">
          {requestTypeNames(row.request_type_ids, typeMap)}
        </span>
      ),
    },
    {
      key: "is_active",
      header: t("admin.wf.deleg.col.flag"),
      width: "8rem",
      render: (row) => (
        <StatusChip status={row.is_active ? "active" : "ended"} map={FLAG_CHIP} />
      ),
    },
    {
      key: "reason",
      header: t("admin.wf.deleg.col.reason"),
      hideBelow: "lg",
      render: (row) => <span className="text-sm">{dash(row.reason)}</span>,
    },
    {
      key: "actions",
      header: t("admin.wf.deleg.col.action"),
      width: "9rem",
      align: "right",
      render: (row) =>
        row.is_active ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              end.reset();
              prompt.ask(row);
            }}
          >
            {t("admin.wf.deleg.action.end")}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">{t("admin.wf.deleg.alreadyEnded")}</span>
        ),
    },
  ];

  const anyFilter = scope !== undefined || requestTypeId !== "" || slice !== "active";

  return (
    <div className="container py-6">
      <PageHeader
        icon={UserCheck}
        title={t("admin.wf.deleg.title")}
        subtitle={
          total.isSuccess
            ? t("admin.wf.deleg.subtitle.count", { n: formatNumber(total.data) })
            : t("admin.wf.deleg.subtitle.plain")
        }
      />

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {TILES.map((tile) => {
          const q = counts[tile.slice];
          const active = slice === tile.slice;
          return (
            <button
              key={tile.slice}
              type="button"
              onClick={() => setParam("slice", active ? "" : tile.slice)}
              aria-pressed={active}
              className={cn(
                "rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                tile.ring,
                active && "ring-2 ring-primary",
              )}
            >
              <p className="text-xs text-muted-foreground">{tile.label}</p>
              <p className="num mt-1 font-display text-2xl font-semibold">
                {q.isPending ? "…" : q.error !== null ? dash(null) : formatNumber(q.data)}
              </p>
            </button>
          );
        })}
      </div>

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-3">
        <SelectField
          label={t("admin.wf.deleg.filter.scope")}
          value={scope ?? ""}
          placeholder={t("admin.wf.deleg.filter.anyScope")}
          options={delegationScopeValues.map((s) => ({
            value: s,
            label: delegationScopeLabel(s),
          }))}
          onChange={(v) => setParam("scope", v)}
        />
        <SelectField
          label={t("admin.wf.deleg.filter.type")}
          value={requestTypeId}
          placeholder={t("admin.wf.deleg.filter.anyType")}
          options={(types.data ?? []).map((rt) => ({ value: rt.id, label: rt.name }))}
          onChange={(v) => setParam("type", v)}
          hint={t("admin.wf.deleg.filter.typeHint")}
        />
        <div className="flex items-end gap-2">
          {anyFilter ? (
            <Button
              variant="ghost"
              onClick={() => setParams(new URLSearchParams(), { replace: true })}
            >
              {t("admin.wf.deleg.filter.clear")}
            </Button>
          ) : null}
        </div>
      </div>

      {ended !== null ? (
        <div className="mt-4">
          <Notice
            tone="success"
            action={
              <Button variant="ghost" size="sm" onClick={() => setEnded(null)}>
                {t("admin.wf.deleg.dismiss")}
              </Button>
            }
          >
            {t("admin.wf.deleg.endedNotice", {
              name:
                people.data?.get(ended.delegate_profile_id)?.display_name ??
                t("admin.wf.deleg.theDelegate"),
            })}
          </Notice>
        </div>
      ) : null}

      <div className="mt-4">
        <StateBoundary
          loading={list.isPending}
          error={list.error}
          onRetry={() => void list.refetch()}
          isEmpty={rows.length === 0}
          partialError={people.error ?? total.error}
          partialLabel={t("admin.wf.deleg.partial")}
          empty={
            <EmptyState
              icon={UserCheck}
              title={
                anyFilter
                  ? t("admin.wf.deleg.empty.filtered.title")
                  : t("admin.wf.deleg.empty.title")
              }
              hint={
                anyFilter
                  ? t("admin.wf.deleg.empty.filtered.hint")
                  : t("admin.wf.deleg.empty.hint")
              }
              {...(anyFilter
                ? {
                    action: (
                      <Button
                        variant="outline"
                        onClick={() => setParams(new URLSearchParams(), { replace: true })}
                      >
                        {t("admin.wf.deleg.filter.clear")}
                      </Button>
                    ),
                  }
                : {})}
            />
          }
        >
          <DataGrid columns={columns} rows={rows} rowKey={(row) => row.id} pageSize={25} />
        </StateBoundary>
      </div>

      <div className="mt-4 space-y-3">
        <Notice tone="info">{t("admin.wf.deleg.inForceNotice")}</Notice>
        <Notice tone="info">{t("admin.wf.deleg.guardNotice")}</Notice>
      </div>

      <ReasonDialog
        open={prompt.isOpen}
        title={t("admin.wf.deleg.dialog.title")}
        description={
          prompt.target === null
            ? t("admin.wf.deleg.dialog.descriptionPlain")
            : t("admin.wf.deleg.dialog.description", {
                to:
                  people.data?.get(prompt.target.delegate_profile_id)?.display_name ??
                  t("admin.wf.deleg.theDelegate"),
                from:
                  people.data?.get(prompt.target.delegator_profile_id)?.display_name ??
                  t("admin.wf.deleg.theDelegator"),
              })
        }
        minLength={SENSITIVE_REASON_LENGTH}
        confirmLabel={t("admin.wf.deleg.dialog.confirm")}
        pending={end.isPending}
        errorMessage={end.userMessage}
        onConfirm={(reason) => {
          const target = prompt.target;
          if (target === null) return;
          end.save({ delegationId: target.id }, reason);
        }}
        onCancel={() => {
          end.reset();
          prompt.close();
        }}
      />
    </div>
  );
}

/** A `profiles.id` rendered as the person it belongs to, or honestly as unknown. */
function PersonOrId({
  profileId,
  people,
}: {
  profileId: string;
  people: PersonRefMap | undefined;
}) {
  const person = people?.get(profileId) ?? null;
  if (person === null) {
    return <span className="text-sm text-muted-foreground">{t("admin.wf.deleg.unknownPerson")}</span>;
  }
  return (
    <PersonCell
      name={person.display_name}
      code={person.employee_code}
      secondary={person.designation_name}
    />
  );
}

/**
 * `request_type_ids` is NULL for "every request type" — the engine's own
 * convention (`resolve_approvers` treats NULL as unrestricted), so it must not
 * render as "none".
 */
function requestTypeNames(ids: readonly string[] | null, typeMap: RequestTypeMap): string {
  if (ids === null) return t("admin.wf.deleg.allTypes");
  if (ids.length === 0) return t("admin.wf.deleg.noTypes");
  const named = ids
    .map((id) => typeMap.get(id)?.name)
    .filter((v): v is string => v !== undefined);
  if (named.length === 0) return t("admin.wf.deleg.nTypes", { n: formatNumber(ids.length) });
  return named.join(", ");
}
