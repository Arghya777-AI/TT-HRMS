/**
 * A-13.4 · /admin/audit/entity/:type/:id — everything ever done to one record.
 *
 * `:type` is the `entity_table` value the audit trigger wrote, so the route is
 * addressable from any row in the console without a lookup table. It is still
 * never RENDERED raw: `entityLabel()` turns it into an authored noun, and the
 * record's own denormalised `entity_label` is preferred over both (D-10/11).
 *
 * Same rows, same columns, same formatters as the timeline — deliberately. This
 * screen is Tab 13 of the employee 360 pointed at an arbitrary table, and if it
 * formatted a date differently from `/admin/audit` the two would be evidence of
 * different things.
 *
 * @route /admin/audit/entity/:type/:id
 */
import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, History, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataGrid } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { fmtDateTime } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { entityLabel } from "../audit/display";
import { AUDIT_PAGE_SIZE, flattenPages, useActorNames, useEntityHistory } from "../audit/hooks";
import { LoadMoreFooter } from "../audit/components/AuditListShell";
import { auditColumns } from "../audit/components/auditColumns";

export default function AuditEntityHistoryPage() {
  const navigate = useNavigate();
  const { type = "", id = "" } = useParams<{ type: string; id: string }>();
  const entityTable = decodeURIComponent(type);

  const history = useEntityHistory(entityTable, id);
  const rows = useMemo(() => flattenPages(history.data), [history.data]);

  const loadedActorIds = useMemo(() => {
    const set = new Set<string>();
    for (const row of rows) if (row.actor_id !== null) set.add(row.actor_id);
    return [...set].sort();
  }, [rows]);
  const actorNames = useActorNames(loadedActorIds);

  // The entity column would repeat the same value on every row (DR-46: identity
  // columns configured off in single-record views).
  const columns = useMemo(
    () => auditColumns({ actors: actorNames.data, hideEntity: true }),
    [actorNames.data],
  );

  // The record's own human label, taken from the rows the trigger denormalised.
  // Falls back to the entity type — never to the uuid in the URL.
  const recordLabel = useMemo(() => {
    for (const row of rows) {
      if (row.entity_label !== null && row.entity_label.trim() !== "") return row.entity_label;
    }
    return entityLabel(entityTable);
  }, [rows, entityTable]);

  const created = rows.length > 0 ? rows[rows.length - 1] : undefined;
  const latest = rows[0];

  return (
    <div className="container py-6">
      <PageHeader
        icon={History}
        title={t("adminAudit.entity.title", { record: recordLabel })}
        subtitle={t("adminAudit.entity.subtitle", { type: entityLabel(entityTable) })}
        actions={
          <Button variant="outline" asChild>
            <Link to="/admin/audit">
              <ArrowLeft className="mr-2 h-4 w-4" aria-hidden />
              {t("adminAudit.diff.backToTimeline")}
            </Link>
          </Button>
        }
      />

      <StateBoundary
        loading={history.isLoading}
        error={history.error ?? undefined}
        onRetry={() => void history.refetch()}
        partialError={actorNames.error ?? undefined}
        partialLabel={t("adminAudit.col.actor")}
        skeletonRows={6}
      >
        {rows.length > 0 ? (
          <section className="mb-4 flex flex-wrap gap-x-8 gap-y-2 rounded-lg border bg-card p-4 text-sm">
            <span>
              <span className="text-muted-foreground">{t("adminAudit.entity.lastChanged")} </span>
              <span className="num">{latest ? fmtDateTime(latest.occurred_at) : ""}</span>
            </span>
            <span>
              <span className="text-muted-foreground">{t("adminAudit.entity.oldestLoaded")} </span>
              <span className="num">{created ? fmtDateTime(created.occurred_at) : ""}</span>
              {history.hasNextPage ? (
                <span className="ml-1 text-xs text-muted-foreground">
                  {t("adminAudit.entity.moreOlder")}
                </span>
              ) : null}
            </span>
          </section>
        ) : null}

        <DataGrid
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          pageSize={AUDIT_PAGE_SIZE}
          onRowClick={(row) => navigate(`/admin/audit/diff/${row.id}`)}
          emptyState={
            <EmptyState
              icon={ShieldCheck}
              title={t("adminAudit.entity.empty.title", { type: entityLabel(entityTable) })}
              hint={t("adminAudit.entity.empty.hint")}
              action={
                <Button variant="outline" asChild>
                  <Link to="/admin/audit">{t("adminAudit.diff.backToTimeline")}</Link>
                </Button>
              }
            />
          }
        />

        <LoadMoreFooter
          loadedCount={rows.length}
          hasNextPage={history.hasNextPage}
          isFetchingNextPage={history.isFetchingNextPage}
          onLoadMore={() => void history.fetchNextPage()}
          unitLabel={t("adminAudit.unit.events")}
        />
      </StateBoundary>
    </div>
  );
}
