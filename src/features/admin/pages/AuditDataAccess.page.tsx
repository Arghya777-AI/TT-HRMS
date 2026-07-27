/**
 * A-13.5 · /admin/audit/data-access — who revealed sensitive data, and why.
 *
 * `data_access_log` is its own append-only table, not a slice of `audit_log`.
 * Every reveal RPC (`reveal_employee_statutory`, `_bank_account`, `_salary`,
 * `_identity_document`, `_face_match_candidates`) writes a row here through
 * `app.log_reveal()`, with `fields` naming the columns that were exposed and
 * `purpose` carrying the sentence the admin typed. `ck_dalog__purpose` enforces a
 * minimum of ten characters at the database level — so unlike most audit
 * surfaces, EVERY row on this screen has a real reason on it, and the "why"
 * column is the point of the screen rather than a nice-to-have.
 *
 * The deployed `access_kind` vocabulary is `reveal | export | report | ai_query |
 * bulk_view` (`ck_dalog__kind`). §13.5's wider list (viewed/downloaded/printed/
 * emailed) would violate that CHECK, so the filter offers what can actually be
 * stored — see `display.ts`.
 *
 * `subject_employee_id` is a uuid on this table with no denormalised label, so
 * the subject column links to the person's own history rather than pretending to
 * a name it does not have.
 *
 * @route /admin/audit/data-access
 */
import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Database, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtCivilDate, fmtDateTime, istParts } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { DataAccessFilters, DataAccessRow } from "../api/audit.api";
import {
  ACCESS_KIND_VALUES,
  accessKindChip,
  accessKindLabel,
  entityLabel,
  fieldsSummary,
  loadedLabel,
  roleLabel,
  sourceLabel,
} from "../audit/display";
import {
  AUDIT_PAGE_SIZE,
  flattenPages,
  useActorNames,
  useActorOptions,
  useDataAccessRegister,
} from "../audit/hooks";
import {
  AuditFilterBar,
  MultiSelectFilter,
  RangeFilter,
  type ActiveChip,
} from "../audit/components/AuditFilterBar";
import { LoadMoreFooter } from "../audit/components/AuditListShell";
import { readList, useAuditUrlFilters } from "../audit/url-state";

/** Sensitive tables the reveal RPCs touch, as the entity filter offers them. */
const SENSITIVE_TABLES: readonly string[] = [
  "employee_statutory",
  "employee_bank_accounts",
  "employee_salary_revisions",
  "identity_documents",
  "face_templates",
  "face_match_log",
  "payslips",
  "documents",
  "audit_log",
];

function isOutOfHours(instant: string): boolean {
  const hour = istParts(instant).hour;
  return hour >= 21 || hour < 7;
}

export default function AuditDataAccessPage() {
  const navigate = useNavigate();
  const { params, preset, window, patch, clearAll, hasActiveFilters } = useAuditUrlFilters("d30");

  const actorIds = readList(params, "actor");
  const accessKinds = readList(params, "kind");
  const entityTables = readList(params, "entity");

  // Joined form = the stable identity of a URL-derived multi-select.
  const actorKey = actorIds.join(",");
  const kindKey = accessKinds.join(",");
  const entityKey = entityTables.join(",");

  // `data_access_log` carries a GENERATED `ist_date` column, so unlike
  // sessions/exports this filter is a plain civil-date comparison — no instant
  // conversion, and no five-and-a-half-hour hole.
  const filters: DataAccessFilters = useMemo(
    () => ({
      from: window.from,
      to: window.to,
      ...(actorIds.length > 0 ? { actorIds } : {}),
      ...(accessKinds.length > 0 ? { accessKinds } : {}),
      ...(entityTables.length > 0 ? { entityTables } : {}),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [window.from, window.to, actorKey, kindKey, entityKey],
  );

  const register = useDataAccessRegister(filters);
  const rows = useMemo(() => flattenPages(register.data), [register.data]);

  const loadedActorIds = useMemo(() => {
    const set = new Set<string>();
    for (const row of rows) if (row.actor_id !== null) set.add(row.actor_id);
    return [...set].sort();
  }, [rows]);
  const names = useActorNames(loadedActorIds);
  const actorOptions = useActorOptions();

  const reveals = useMemo(() => rows.filter((r) => r.access_kind === "reveal").length, [rows]);
  const outOfHours = useMemo(() => rows.filter((r) => isOutOfHours(r.accessed_at)).length, [rows]);
  const distinctSubjects = useMemo(
    () => new Set(rows.map((r) => r.subject_employee_id).filter((v) => v !== null)).size,
    [rows],
  );
  const distinctActors = useMemo(() => loadedActorIds.length, [loadedActorIds]);

  const scopeNumbers = t("adminAudit.dataAccess.scopeNumbers", {
    n: formatNumber(rows.length),
    from: fmtCivilDate(window.from),
    to: fmtCivilDate(window.to),
  });

  const columns: DataGridColumn<DataAccessRow>[] = useMemo(
    () => [
      {
        key: "accessed_at",
        header: t("adminAudit.col.when"),
        width: "12rem",
        sortable: true,
        sortValue: (row) => row.accessed_at,
        render: (row) => (
          <span className="num whitespace-nowrap">{fmtDateTime(row.accessed_at)}</span>
        ),
      },
      {
        key: "access_kind",
        header: t("adminAudit.dataAccess.col.kind"),
        width: "9rem",
        render: (row) => (
          <StatusChip status={row.access_kind} map={accessKindChip(row.access_kind)} />
        ),
      },
      {
        key: "actor",
        header: t("adminAudit.col.actor"),
        width: "13rem",
        render: (row) => {
          const profile = row.actor_id !== null ? names.data?.get(row.actor_id) : undefined;
          const body = (
            <span className="flex flex-col leading-tight">
              <span className="truncate">
                {profile?.full_name ?? t("adminAudit.actor.system")}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {roleLabel(row.actor_role)} · {sourceLabel(row.actor_source)}
              </span>
            </span>
          );
          if (row.actor_id === null) return body;
          return (
            <span onClick={(e) => e.stopPropagation()}>
              <Link
                to={`/admin/audit/user/${row.actor_id}`}
                className="rounded underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {body}
              </Link>
            </span>
          );
        },
      },
      {
        key: "fields",
        header: t("adminAudit.dataAccess.col.fields"),
        render: (row) => (
          <span className="flex flex-col leading-tight">
            <span className="text-sm">{fieldsSummary(row.fields)}</span>
            <span className="text-xs text-muted-foreground">
              {entityLabel(row.entity_table)}
            </span>
          </span>
        ),
      },
      {
        key: "subject",
        header: t("adminAudit.dataAccess.col.subject"),
        width: "10rem",
        hideBelow: "md",
        render: (row) =>
          row.subject_employee_id === null ? (
            <span className="text-sm text-muted-foreground">
              {t("adminAudit.dataAccess.noSubject")}
            </span>
          ) : (
            <span onClick={(e) => e.stopPropagation()}>
              <Link
                to={`/admin/audit/entity/employees/${row.subject_employee_id}`}
                className="rounded text-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t("adminAudit.dataAccess.viewSubject")}
              </Link>
            </span>
          ),
      },
      {
        key: "record_count",
        header: t("adminAudit.dataAccess.col.records"),
        width: "7rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => dash(row.record_count, formatNumber),
      },
      {
        key: "purpose",
        header: t("adminAudit.dataAccess.col.purpose"),
        render: (row) => (
          <span className="line-clamp-2 text-sm" title={row.purpose}>
            {row.purpose}
          </span>
        ),
      },
      {
        key: "flags",
        header: t("adminAudit.col.flags"),
        width: "7rem",
        align: "center",
        hideBelow: "lg",
        render: (row) =>
          isOutOfHours(row.accessed_at) ? (
            <span className="inline-flex items-center gap-1 text-xs text-warning">
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
              {t("adminAudit.sessions.outOfHours")}
            </span>
          ) : (
            dash(null)
          ),
      },
    ],
    [names.data],
  );

  const chips: readonly ActiveChip[] = useMemo(() => {
    const out: ActiveChip[] = [];
    const nameOf = (id: string): string =>
      (actorOptions.data ?? []).find((a) => a.id === id)?.full_name ?? t("adminAudit.actor.unknown");
    for (const id of actorIds) {
      out.push({
        id: `actor:${id}`,
        label: t("adminAudit.chip.actor", { value: nameOf(id) }),
        onRemove: () => patch({ actor: actorIds.filter((v) => v !== id) }),
      });
    }
    for (const k of accessKinds) {
      out.push({
        id: `kind:${k}`,
        label: t("adminAudit.chip.kind", { value: accessKindLabel(k) }),
        onRemove: () => patch({ kind: accessKinds.filter((v) => v !== k) }),
      });
    }
    for (const e of entityTables) {
      out.push({
        id: `entity:${e}`,
        label: t("adminAudit.chip.entity", { value: entityLabel(e) }),
        onRemove: () => patch({ entity: entityTables.filter((v) => v !== e) }),
      });
    }
    return out;
  }, [actorIds, accessKinds, entityTables, actorOptions.data, patch]);

  return (
    <div className="container py-6">
      <PageHeader
        icon={Database}
        title={t("adminAudit.dataAccess.title")}
        subtitle={t("adminAudit.dataAccess.subtitle")}
      />

      <AuditFilterBar
        chips={chips}
        onClearAll={clearAll}
        resultLabel={loadedLabel(rows.length, register.hasNextPage)}
      >
        <RangeFilter preset={preset} window={window} patch={patch} />
        <MultiSelectFilter
          label={t("adminAudit.filter.actor")}
          options={(actorOptions.data ?? []).map((a) => ({
            value: a.id,
            label: a.full_name,
            hint: a.email,
          }))}
          selected={actorIds}
          onChange={(next) => patch({ actor: next })}
          searchable
          loading={actorOptions.isLoading}
          emptyHint={t("adminAudit.filter.noActors")}
        />
        <MultiSelectFilter
          label={t("adminAudit.dataAccess.filter.kind")}
          options={ACCESS_KIND_VALUES.map((k) => ({ value: k, label: accessKindLabel(k) }))}
          selected={accessKinds}
          onChange={(next) => patch({ kind: next })}
        />
        <MultiSelectFilter
          label={t("adminAudit.dataAccess.filter.entity")}
          options={SENSITIVE_TABLES.map((e) => ({ value: e, label: entityLabel(e) }))}
          selected={entityTables}
          onChange={(next) => patch({ entity: next })}
          searchable
        />
      </AuditFilterBar>

      <StateBoundary
        loading={register.isLoading}
        error={register.error ?? undefined}
        onRetry={() => void register.refetch()}
        partialError={names.error ?? undefined}
        partialLabel={t("adminAudit.col.actor")}
        skeletonRows={8}
      >
        {rows.length > 0 ? (
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiTile
              label={t("adminAudit.dataAccess.kpi.reveals")}
              value={formatNumber(reveals)}
              tone={reveals > 0 ? "warn" : "neutral"}
              explainer={{
                formula: t("adminAudit.dataAccess.kpi.revealsFormula"),
                numbers: scopeNumbers,
              }}
            />
            <KpiTile
              label={t("adminAudit.dataAccess.kpi.actors")}
              value={formatNumber(distinctActors)}
              explainer={{
                formula: t("adminAudit.dataAccess.kpi.actorsFormula"),
                numbers: scopeNumbers,
              }}
            />
            <KpiTile
              label={t("adminAudit.dataAccess.kpi.subjects")}
              value={formatNumber(distinctSubjects)}
              explainer={{
                formula: t("adminAudit.dataAccess.kpi.subjectsFormula"),
                numbers: scopeNumbers,
              }}
            />
            <KpiTile
              label={t("adminAudit.dataAccess.kpi.outOfHours")}
              value={formatNumber(outOfHours)}
              tone={outOfHours > 0 ? "info" : "neutral"}
              explainer={{
                formula: t("adminAudit.dataAccess.kpi.outOfHoursFormula"),
                numbers: scopeNumbers,
              }}
            />
          </div>
        ) : null}

        <DataGrid
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          pageSize={AUDIT_PAGE_SIZE}
          onRowClick={(row) => {
            if (row.actor_id !== null) navigate(`/admin/audit/user/${row.actor_id}`);
          }}
          emptyState={
            hasActiveFilters ? (
              <EmptyState
                icon={ShieldCheck}
                title={t("adminAudit.dataAccess.emptyFiltered.title")}
                hint={t("adminAudit.timeline.emptyFiltered.hint")}
                action={
                  <Button variant="outline" onClick={clearAll}>
                    {t("adminAudit.filters.clearAll")}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={ShieldCheck}
                title={t("adminAudit.dataAccess.empty.title")}
                hint={t("adminAudit.dataAccess.empty.hint")}
              />
            )
          }
        />

        <LoadMoreFooter
          loadedCount={rows.length}
          hasNextPage={register.hasNextPage}
          isFetchingNextPage={register.isFetchingNextPage}
          onLoadMore={() => void register.fetchNextPage()}
          unitLabel={t("adminAudit.unit.reveals")}
        />
      </StateBoundary>

      <p className="mt-4 text-xs text-muted-foreground">{t("adminAudit.dataAccess.footnote")}</p>
    </div>
  );
}
