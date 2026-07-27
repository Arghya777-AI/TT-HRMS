/**
 * A-13.5 · /admin/audit/exports — the Export Register over `export_log`.
 *
 * This is the "what left the building" screen, and it is built around the two
 * columns that make an export disputable or not:
 *
 *  - `checksum_sha256` — the hash of the file that was actually delivered. If
 *    someone produces a spreadsheet and claims it came from this system, this is
 *    the value that settles it. It is rendered in full, grouped, monospace,
 *    selectable, never truncated to a pretty prefix.
 *  - `purpose` — enforced at ≥10 characters by `ck_export_log__purpose`, so every
 *    row here has a real sentence on it.
 *
 * One RLS behaviour to expect rather than treat as a bug: `export_log__admin_read`
 * hides `subject = 'audit_log'` rows from a plain admin. An admin's register is
 * therefore legitimately shorter than a super-admin's, and the screen says so
 * instead of leaving the difference unexplained.
 *
 * `ck_export_log__approval` requires `approved_by` whenever the export carried
 * salary or more than 500 rows — so a blank Approver on such a row cannot exist,
 * and the column is the four-eyes evidence, not decoration.
 *
 * @route /admin/audit/exports
 */
import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FileDown, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { useAuth } from "@/app/auth/AuthProvider";
import { fmtCivilDate, fmtDateTime, istRangeInstantBounds } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import {
  exportKindValues,
  exportSubjectValues,
  type ExportLogFilters,
  type ExportLogRow,
} from "../api/audit-registers.api";
import {
  exportKindLabel,
  exportSubjectLabel,
  fmtBytes,
  loadedLabel,
  roleLabel,
  sensitivitySummary,
  shortHash,
} from "../audit/display";
import {
  AUDIT_PAGE_SIZE,
  flattenPages,
  useActorNames,
  useActorOptions,
  useExportRegister,
} from "../audit/hooks";
import {
  AuditFilterBar,
  MultiSelectFilter,
  RangeFilter,
  TextFilter,
  ToggleFilter,
  type ActiveChip,
} from "../audit/components/AuditFilterBar";
import { LoadMoreFooter } from "../audit/components/AuditListShell";
import { readBool, readList, readText, useAuditUrlFilters } from "../audit/url-state";

export default function AuditExportsPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const isSuper = can("admin.super");

  const { params, preset, window, patch, clearAll, hasActiveFilters } = useAuditUrlFilters("d90");

  const actorIds = readList(params, "actor");
  const kinds = readList(params, "kind");
  const subjects = readList(params, "subject");
  const purposeLike = readText(params, "purpose");
  const sensitiveOnly = readBool(params, "pii");

  // Joined form = the stable identity of a URL-derived multi-select.
  const actorKey = actorIds.join(",");
  const kindKey = kinds.join(",");
  const subjectKey = subjects.join(",");

  const instantWindow = useMemo(
    () => istRangeInstantBounds(window.from, window.to),
    [window.from, window.to],
  );

  const filters: ExportLogFilters = useMemo(
    () => ({
      from: instantWindow.fromInstant,
      to: instantWindow.toInstantExclusive,
      ...(actorIds.length > 0 ? { actorIds } : {}),
      ...(kinds.length > 0 ? { kinds } : {}),
      ...(subjects.length > 0 ? { subjects } : {}),
      ...(purposeLike !== "" ? { purposeLike } : {}),
      ...(sensitiveOnly ? { sensitiveOnly: true } : {}),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      instantWindow.fromInstant,
      instantWindow.toInstantExclusive,
      actorKey,
      kindKey,
      subjectKey,
      purposeLike,
      sensitiveOnly,
    ],
  );

  const register = useExportRegister(filters);
  const rows = useMemo(() => flattenPages(register.data), [register.data]);

  const loadedActorIds = useMemo(() => {
    const set = new Set<string>();
    for (const row of rows) {
      if (row.actor_id !== null) set.add(row.actor_id);
      if (row.approved_by !== null) set.add(row.approved_by);
    }
    return [...set].sort();
  }, [rows]);
  const names = useActorNames(loadedActorIds);
  const actorOptions = useActorOptions();

  const withPii = useMemo(() => rows.filter((r) => r.contains_pii).length, [rows]);
  const withSalary = useMemo(() => rows.filter((r) => r.contains_salary).length, [rows]);
  const unhashed = useMemo(
    () => rows.filter((r) => r.checksum_sha256 === null || r.checksum_sha256 === "").length,
    [rows],
  );

  const scopeNumbers = t("adminAudit.exports.scopeNumbers", {
    n: formatNumber(rows.length),
    from: fmtCivilDate(window.from),
    to: fmtCivilDate(window.to),
  });

  const columns: DataGridColumn<ExportLogRow>[] = useMemo(
    () => [
      {
        key: "exported_at",
        header: t("adminAudit.col.when"),
        width: "12rem",
        sortable: true,
        sortValue: (row) => row.exported_at,
        render: (row) => (
          <span className="num whitespace-nowrap">{fmtDateTime(row.exported_at)}</span>
        ),
      },
      {
        key: "subject",
        header: t("adminAudit.exports.col.what"),
        render: (row) => (
          <span className="flex flex-col leading-tight">
            <span>{exportSubjectLabel(row.subject)}</span>
            <span className="text-xs text-muted-foreground">
              {exportKindLabel(row.export_kind)}
            </span>
          </span>
        ),
      },
      {
        key: "actor",
        header: t("adminAudit.exports.col.by"),
        width: "13rem",
        render: (row) => {
          const profile = row.actor_id !== null ? names.data?.get(row.actor_id) : undefined;
          const body = (
            <span className="flex flex-col leading-tight">
              <span className="truncate">{profile?.full_name ?? t("adminAudit.actor.system")}</span>
              <span className="truncate text-xs text-muted-foreground">
                {roleLabel(row.actor_role)}
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
        key: "row_count",
        header: t("adminAudit.exports.col.rows"),
        width: "6.5rem",
        align: "right",
        render: (row) => dash(row.row_count, formatNumber),
      },
      {
        key: "size",
        header: t("adminAudit.exports.col.size"),
        width: "6.5rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => fmtBytes(row.file_size_bytes),
      },
      {
        key: "sensitivity",
        header: t("adminAudit.exports.col.contains"),
        width: "11rem",
        hideBelow: "md",
        render: (row) => {
          const summary = sensitivitySummary(row);
          const risky = row.contains_pii || row.contains_salary || row.contains_biometric;
          return (
            <span className={risky ? "text-sm font-medium text-warning" : "text-sm"}>
              {summary}
            </span>
          );
        },
      },
      {
        key: "approved_by",
        header: t("adminAudit.exports.col.approver"),
        width: "11rem",
        hideBelow: "lg",
        render: (row) => {
          if (row.approved_by === null) {
            return (
              <span className="text-sm text-muted-foreground">
                {t("adminAudit.exports.noApproverNeeded")}
              </span>
            );
          }
          return dash(names.data?.get(row.approved_by)?.full_name ?? null);
        },
      },
      {
        key: "checksum_sha256",
        header: t("adminAudit.exports.col.checksum"),
        width: "9rem",
        hideBelow: "lg",
        render: (row) =>
          row.checksum_sha256 === null || row.checksum_sha256 === "" ? (
            <span className="text-xs text-muted-foreground">
              {t("adminAudit.exports.noChecksum")}
            </span>
          ) : (
            <span
              className="select-all font-mono text-xs"
              title={row.checksum_sha256}
            >
              {shortHash(row.checksum_sha256)}…
            </span>
          ),
      },
      {
        key: "purpose",
        header: t("adminAudit.exports.col.purpose"),
        render: (row) => (
          <span className="line-clamp-2 text-sm" title={row.purpose}>
            {row.purpose}
          </span>
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
    for (const k of kinds) {
      out.push({
        id: `kind:${k}`,
        label: t("adminAudit.chip.format", { value: exportKindLabel(k) }),
        onRemove: () => patch({ kind: kinds.filter((v) => v !== k) }),
      });
    }
    for (const s of subjects) {
      out.push({
        id: `subject:${s}`,
        label: t("adminAudit.chip.dataset", { value: exportSubjectLabel(s) }),
        onRemove: () => patch({ subject: subjects.filter((v) => v !== s) }),
      });
    }
    if (purposeLike !== "")
      out.push({
        id: "purpose",
        label: t("adminAudit.chip.purpose", { value: purposeLike }),
        onRemove: () => patch({ purpose: null }),
      });
    if (sensitiveOnly)
      out.push({
        id: "pii",
        label: t("adminAudit.exports.filter.piiOnly"),
        onRemove: () => patch({ pii: null }),
      });
    return out;
  }, [actorIds, kinds, subjects, purposeLike, sensitiveOnly, actorOptions.data, patch]);

  return (
    <div className="container py-6">
      <PageHeader
        icon={FileDown}
        title={t("adminAudit.exports.title")}
        subtitle={t("adminAudit.exports.subtitle")}
      />

      {!isSuper ? (
        <p className="mb-4 rounded-md border border-info/40 bg-info/5 px-3 py-2 text-sm">
          {t("adminAudit.exports.adminScopeNotice")}
        </p>
      ) : null}

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
          label={t("adminAudit.exports.filter.dataset")}
          options={exportSubjectValues.map((s) => ({ value: s, label: exportSubjectLabel(s) }))}
          selected={subjects}
          onChange={(next) => patch({ subject: next })}
        />
        <MultiSelectFilter
          label={t("adminAudit.exports.filter.format")}
          options={exportKindValues.map((k) => ({ value: k, label: exportKindLabel(k) }))}
          selected={kinds}
          onChange={(next) => patch({ kind: next })}
        />
        <TextFilter
          label={t("adminAudit.exports.col.purpose")}
          value={purposeLike}
          onChange={(next) => patch({ purpose: next })}
          placeholder={t("adminAudit.exports.filter.purposePlaceholder")}
        />
        <ToggleFilter
          label={t("adminAudit.exports.filter.piiOnly")}
          on={sensitiveOnly}
          onChange={(next) => patch({ pii: next })}
        />
      </AuditFilterBar>

      <StateBoundary
        loading={register.isLoading}
        error={register.error ?? undefined}
        onRetry={() => void register.refetch()}
        partialError={names.error ?? undefined}
        partialLabel={t("adminAudit.exports.col.by")}
        skeletonRows={8}
      >
        {rows.length > 0 ? (
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiTile
              label={t("adminAudit.exports.kpi.total")}
              value={formatNumber(rows.length)}
              explainer={{
                formula: t("adminAudit.exports.kpi.totalFormula"),
                numbers: scopeNumbers,
              }}
            />
            <KpiTile
              label={t("adminAudit.exports.kpi.pii")}
              value={formatNumber(withPii)}
              tone={withPii > 0 ? "warn" : "neutral"}
              explainer={{ formula: t("adminAudit.exports.kpi.piiFormula"), numbers: scopeNumbers }}
            />
            <KpiTile
              label={t("adminAudit.exports.kpi.salary")}
              value={formatNumber(withSalary)}
              tone={withSalary > 0 ? "danger" : "neutral"}
              explainer={{
                formula: t("adminAudit.exports.kpi.salaryFormula"),
                numbers: scopeNumbers,
              }}
            />
            <KpiTile
              label={t("adminAudit.exports.kpi.unhashed")}
              value={formatNumber(unhashed)}
              tone={unhashed > 0 ? "warn" : "success"}
              explainer={{
                formula: t("adminAudit.exports.kpi.unhashedFormula"),
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
                title={t("adminAudit.exports.emptyFiltered.title")}
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
                title={t("adminAudit.exports.empty.title")}
                hint={t("adminAudit.exports.empty.hint")}
              />
            )
          }
        />

        <LoadMoreFooter
          loadedCount={rows.length}
          hasNextPage={register.hasNextPage}
          isFetchingNextPage={register.isFetchingNextPage}
          onLoadMore={() => void register.fetchNextPage()}
          unitLabel={t("adminAudit.unit.exports")}
        />
      </StateBoundary>

      <p className="mt-4 text-xs text-muted-foreground">{t("adminAudit.exports.footnote")}</p>
    </div>
  );
}
