/**
 * A-13.2 · /admin/audit — the Audit Timeline.
 *
 * This is the client's headline requirement ("every audit trail of everything"),
 * so the load-bearing property is that it is SEARCHABLE, not that it is complete.
 * A complete, unsearchable dump of `audit_log` answers no question anyone has.
 *
 * What makes it searchable rather than a dump:
 *  - Eleven server-side filters over the indexed columns `audit_log` actually
 *    has (`ist_date`, `actor_id`, `action`, `entity_table`, `field_name`,
 *    `reason`, `entity_label`), every one of them in the URL.
 *  - Each row reads as a plain-English sentence on mobile and as typed
 *    old → new columns on desktop, with money as ₹, dates as dd-MMM-yyyy and
 *    durations as `7h 50m` — the same formatters as the rest of the app.
 *  - Keyset paging, because this table is being appended to while it is read.
 *
 * Nothing on this screen is computed: there is no total, no percentage and no
 * average, only rows the server returned and a count of the rows now loaded.
 *
 * @route /admin/audit
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Download, ScrollText, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataGrid } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { SENSITIVE_REASON_LENGTH } from "@/shared/api/query";
import { qk } from "@/shared/api/keys";
import { useAuditedMutation } from "@/shared/hooks/useAuditedMutation";
import { useAuth } from "@/app/auth/AuthProvider";
import { fmtCivilDate } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import {
  auditActionValues,
  exportAuditTrail,
  type AuditFilters,
} from "../api/audit.api";
import {
  ACTOR_SOURCE_VALUES,
  APP_ROLE_VALUES,
  AUDITED_ENTITY_TABLES,
  actionLabel,
  entityLabel,
  loadedLabel,
  roleLabel,
  sourceLabel,
} from "../audit/display";
import { AUDIT_PAGE_SIZE, flattenPages, useActorNames, useActorOptions, useAuditTimeline } from "../audit/hooks";
import {
  AuditFilterBar,
  MultiSelectFilter,
  RangeFilter,
  TextFilter,
  ToggleFilter,
  type ActiveChip,
  type SelectOption,
} from "../audit/components/AuditFilterBar";
import { LoadMoreFooter } from "../audit/components/AuditListShell";
import { auditColumns, auditRowSentence } from "../audit/components/auditColumns";
import { readBool, readList, readText, useAuditUrlFilters } from "../audit/url-state";

export default function AuditTimelinePage() {
  const navigate = useNavigate();
  const { can, employee } = useAuth();
  const isSuper = can("admin.super") || can("admin.audit.read");

  const { params, preset, window, patch, clearAll, hasActiveFilters } = useAuditUrlFilters("d30");

  const actorIds = readList(params, "actor");
  const actorRoles = readList(params, "role");
  const actions = readList(params, "action");
  const entityTables = readList(params, "entity");
  const sources = readList(params, "source");
  const fieldLike = readText(params, "field");
  const labelLike = readText(params, "q");
  const reasonLike = readText(params, "reason");
  const onlyWithReason = readBool(params, "hasReason");
  const redactedOnly = readBool(params, "redacted");

  // Multi-selects are rebuilt from the URL every render, so their JOINED form is
  // the stable identity a dependency array can actually compare.
  const actorKey = actorIds.join(",");
  const roleKey = actorRoles.join(",");
  const actionKey = actions.join(",");
  const entityKey = entityTables.join(",");
  const sourceKey = sources.join(",");

  // `exactOptionalPropertyTypes` is on: an absent filter must be ABSENT, not
  // `undefined`, or the object no longer satisfies AuditFilters.
  const filters: AuditFilters = useMemo(
    () => ({
      from: window.from,
      to: window.to,
      ...(actorIds.length > 0 ? { actorIds } : {}),
      ...(actorRoles.length > 0 ? { actorRoles } : {}),
      ...(actions.length > 0 ? { actions } : {}),
      ...(entityTables.length > 0 ? { entityTables } : {}),
      ...(sources.length > 0 ? { sources } : {}),
      ...(fieldLike !== "" ? { fieldLike } : {}),
      ...(labelLike !== "" ? { labelLike } : {}),
      ...(reasonLike !== "" ? { reasonLike } : {}),
      ...(onlyWithReason ? { onlyWithReason: true } : {}),
      ...(redactedOnly ? { redactedOnly: true } : {}),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      window.from,
      window.to,
      actorKey,
      roleKey,
      actionKey,
      entityKey,
      sourceKey,
      fieldLike,
      labelLike,
      reasonLike,
      onlyWithReason,
      redactedOnly,
    ],
  );

  const timeline = useAuditTimeline(filters);
  const rows = useMemo(() => flattenPages(timeline.data), [timeline.data]);

  // Resolve only the actors present on the loaded pages. A failure is partial:
  // the grid still shows the denormalised email `audit_log` carries.
  const loadedActorIds = useMemo(() => {
    const set = new Set<string>();
    for (const row of rows) if (row.actor_id !== null) set.add(row.actor_id);
    return [...set].sort();
  }, [rows]);
  const actorNames = useActorNames(loadedActorIds);
  const actorOptions = useActorOptions();

  const columns = useMemo(() => auditColumns({ actors: actorNames.data }), [actorNames.data]);

  // --- Export (super_admin + reason ≥ 15, itself audited) -------------------
  const [exportOpen, setExportOpen] = useState(false);
  const exportMutation = useAuditedMutation<unknown, AuditFilters>({
    mutationFn: (input, reason) => exportAuditTrail(input, reason),
    minReasonLength: SENSITIVE_REASON_LENGTH,
    // The export writes an `export` audit row and an `export_log` row, so both
    // registers this console shows are now stale.
    invalidate: [qk.admin.auditAll()],
    onSuccess: () => setExportOpen(false),
  });

  const actorSelectOptions: readonly SelectOption[] = useMemo(
    () =>
      (actorOptions.data ?? []).map((a) => ({
        value: a.id,
        label: a.full_name,
        hint: a.email,
      })),
    [actorOptions.data],
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
    for (const r of actorRoles) {
      out.push({
        id: `role:${r}`,
        label: t("adminAudit.chip.role", { value: roleLabel(r) }),
        onRemove: () => patch({ role: actorRoles.filter((v) => v !== r) }),
      });
    }
    for (const a of actions) {
      out.push({
        id: `action:${a}`,
        label: t("adminAudit.chip.action", { value: actionLabel(a) }),
        onRemove: () => patch({ action: actions.filter((v) => v !== a) }),
      });
    }
    for (const e of entityTables) {
      out.push({
        id: `entity:${e}`,
        label: t("adminAudit.chip.entity", { value: entityLabel(e) }),
        onRemove: () => patch({ entity: entityTables.filter((v) => v !== e) }),
      });
    }
    for (const s of sources) {
      out.push({
        id: `source:${s}`,
        label: t("adminAudit.chip.source", { value: sourceLabel(s) }),
        onRemove: () => patch({ source: sources.filter((v) => v !== s) }),
      });
    }
    if (fieldLike !== "")
      out.push({
        id: "field",
        label: t("adminAudit.chip.field", { value: fieldLike }),
        onRemove: () => patch({ field: null }),
      });
    if (labelLike !== "")
      out.push({
        id: "q",
        label: t("adminAudit.chip.record", { value: labelLike }),
        onRemove: () => patch({ q: null }),
      });
    if (reasonLike !== "")
      out.push({
        id: "reason",
        label: t("adminAudit.chip.reason", { value: reasonLike }),
        onRemove: () => patch({ reason: null }),
      });
    if (onlyWithReason)
      out.push({
        id: "hasReason",
        label: t("adminAudit.filter.hasReason"),
        onRemove: () => patch({ hasReason: null }),
      });
    if (redactedOnly)
      out.push({
        id: "redacted",
        label: t("adminAudit.filter.redactedOnly"),
        onRemove: () => patch({ redacted: null }),
      });
    return out;
  }, [
    actorIds,
    actorRoles,
    actions,
    entityTables,
    sources,
    fieldLike,
    labelLike,
    reasonLike,
    onlyWithReason,
    redactedOnly,
    actorOptions.data,
    patch,
  ]);

  return (
    <div className="container py-6">
      <PageHeader
        icon={ScrollText}
        title={t("adminAudit.timeline.title")}
        subtitle={t("adminAudit.timeline.subtitle")}
        actions={
          isSuper ? (
            <Button variant="outline" onClick={() => setExportOpen(true)} disabled={rows.length === 0}>
              <Download className="mr-2 h-4 w-4" aria-hidden />
              {t("adminAudit.timeline.export")}
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">{t("adminAudit.timeline.exportSuperOnly")}</span>
          )
        }
      />

      <AuditFilterBar
        chips={chips}
        onClearAll={clearAll}
        resultLabel={loadedLabel(rows.length, timeline.hasNextPage)}
      >
        <RangeFilter preset={preset} window={window} patch={patch} />
        <MultiSelectFilter
          label={t("adminAudit.filter.actor")}
          options={actorSelectOptions}
          selected={actorIds}
          onChange={(next) => patch({ actor: next })}
          searchable
          loading={actorOptions.isLoading}
          emptyHint={t("adminAudit.filter.noActors")}
        />
        <MultiSelectFilter
          label={t("adminAudit.filter.action")}
          options={auditActionValues.map((a) => ({ value: a, label: actionLabel(a) }))}
          selected={actions}
          onChange={(next) => patch({ action: next })}
          searchable
        />
        <MultiSelectFilter
          label={t("adminAudit.filter.entity")}
          options={AUDITED_ENTITY_TABLES.map((e) => ({ value: e, label: entityLabel(e) }))}
          selected={entityTables}
          onChange={(next) => patch({ entity: next })}
          searchable
        />
        <MultiSelectFilter
          label={t("adminAudit.filter.role")}
          options={APP_ROLE_VALUES.map((r) => ({ value: r, label: roleLabel(r) }))}
          selected={actorRoles}
          onChange={(next) => patch({ role: next })}
        />
        <MultiSelectFilter
          label={t("adminAudit.filter.source")}
          options={ACTOR_SOURCE_VALUES.map((s) => ({ value: s, label: sourceLabel(s) }))}
          selected={sources}
          onChange={(next) => patch({ source: next })}
        />
        <TextFilter
          label={t("adminAudit.filter.record")}
          value={labelLike}
          onChange={(next) => patch({ q: next })}
          placeholder={t("adminAudit.filter.recordPlaceholder")}
        />
        <TextFilter
          label={t("adminAudit.filter.field")}
          value={fieldLike}
          onChange={(next) => patch({ field: next })}
          placeholder={t("adminAudit.filter.fieldPlaceholder")}
          widthClass="w-36"
        />
        <TextFilter
          label={t("adminAudit.filter.reasonText")}
          value={reasonLike}
          onChange={(next) => patch({ reason: next })}
          placeholder={t("adminAudit.filter.reasonPlaceholder")}
        />
        <ToggleFilter
          label={t("adminAudit.filter.hasReason")}
          on={onlyWithReason}
          onChange={(next) => patch({ hasReason: next })}
        />
        <ToggleFilter
          label={t("adminAudit.filter.redactedOnly")}
          on={redactedOnly}
          onChange={(next) => patch({ redacted: next })}
        />
      </AuditFilterBar>

      <StateBoundary
        loading={timeline.isLoading}
        error={timeline.error ?? undefined}
        onRetry={() => void timeline.refetch()}
        partialError={actorNames.error ?? undefined}
        partialLabel={t("adminAudit.col.actor")}
        skeletonRows={8}
      >
        <DataGrid
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          pageSize={AUDIT_PAGE_SIZE}
          onRowClick={(row) => navigate(`/admin/audit/diff/${row.id}`)}
          emptyState={
            hasActiveFilters ? (
              <EmptyState
                icon={ShieldCheck}
                title={t("adminAudit.timeline.emptyFiltered.title")}
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
                title={t("adminAudit.timeline.empty.title")}
                hint={t("adminAudit.timeline.empty.hint")}
              />
            )
          }
        />

        {/* The sentence form of the same rows, for screen readers and for anyone
            who wants the log to read like a narrative rather than a table. */}
        <ul className="sr-only">
          {rows.map((row) => (
            <li key={`sentence-${row.id}`}>{auditRowSentence(row, actorNames.data)}</li>
          ))}
        </ul>

        <LoadMoreFooter
          loadedCount={rows.length}
          hasNextPage={timeline.hasNextPage}
          isFetchingNextPage={timeline.isFetchingNextPage}
          onLoadMore={() => void timeline.fetchNextPage()}
          unitLabel={t("adminAudit.unit.events")}
        />
      </StateBoundary>

      <ReasonDialog
        open={exportOpen}
        title={t("adminAudit.export.dialog.title")}
        description={t("adminAudit.export.dialog.description", {
          from: fmtCivilDate(window.from),
          to: fmtCivilDate(window.to),
        })}
        actorName={employee?.displayName ?? null}
        minLength={SENSITIVE_REASON_LENGTH}
        confirmLabel={t("adminAudit.export.dialog.confirm")}
        pending={exportMutation.isPending}
        errorMessage={exportMutation.userMessage}
        onConfirm={(reason) => exportMutation.save(filters, reason)}
        onCancel={() => setExportOpen(false)}
      />

      <p className="mt-4 text-xs text-muted-foreground">{t("adminAudit.timeline.footnote")}</p>
    </div>
  );
}
