/**
 * A-13.4 · /admin/audit/user/:userId — everything one actor has done.
 *
 * `:userId` is a `profiles.id` (= `auth.users.id`), which is what
 * `audit_log.actor_id`, `data_access_log.actor_id`, `export_log.actor_id` and
 * `sessions_audit.profile_id` all hold — so one route id opens all four
 * registers for the same person. The three sibling registers are linked rather
 * than embedded: each has its own screen with its own filters, and duplicating
 * them here is how a mega-tab page starts.
 *
 * The activity strips: §13.4 asks for a per-day and an hourly heat strip. Both
 * are computed from the LOADED rows and say so in as many words. That is the
 * DR-28/DR-31 rule taken seriously — a figure on screen must be the aggregate of
 * the exact series on screen, or it must be `—`. There is no server view that
 * buckets audit events by hour, so the alternative to labelling the scope
 * honestly would be inventing a total, which is the defect this build exists to
 * avoid.
 *
 * @route /admin/audit/user/:userId
 */
import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Database, Download, KeyRound, ShieldCheck, UserCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataGrid } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { fmtCivilDate, istParts } from "@/lib/datetime";
import { formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { ActorProfile } from "../api/audit-registers.api";
import type { AuditFilters, AuditRow } from "../api/audit.api";
import { auditActionValues } from "../api/audit.api";
import { actionLabel, isSensitiveAction, loadedLabel } from "../audit/display";
import {
  AUDIT_PAGE_SIZE,
  flattenPages,
  useActorProfile,
  useActorTrail,
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
import { auditColumns } from "../audit/components/auditColumns";
import { readBool, readList, readText, useAuditUrlFilters } from "../audit/url-state";

/** 24 buckets from the loaded rows. Presentational, and scoped in the caption. */
function hourlyBuckets(rows: readonly AuditRow[]): readonly number[] {
  const buckets = new Array<number>(24).fill(0);
  for (const row of rows) {
    const hour = istParts(row.occurred_at).hour;
    const current = buckets[hour];
    if (current !== undefined) buckets[hour] = current + 1;
  }
  return buckets;
}

function HourStrip({ rows }: { readonly rows: readonly AuditRow[] }) {
  const buckets = hourlyBuckets(rows);
  const peak = buckets.reduce((max, n) => (n > max ? n : max), 0);
  if (peak === 0) return null;
  return (
    <section className="rounded-lg border bg-card p-4">
      <h2 className="font-display text-base font-semibold">{t("adminAudit.user.hourStrip")}</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {t("adminAudit.user.hourStripScope", { n: formatNumber(rows.length) })}
      </p>
      <ol className="mt-3 flex items-end gap-[3px]" aria-hidden>
        {buckets.map((count, hour) => (
          <li
            key={hour}
            className="flex-1"
            title={t("adminAudit.user.hourTooltip", { hour: String(hour).padStart(2, "0"), n: count })}
          >
            <div
              className={
                count === 0
                  ? "h-8 rounded-sm bg-muted"
                  : hour < 7 || hour >= 21
                    ? "rounded-sm bg-warning/70"
                    : "rounded-sm bg-primary/70"
              }
              style={count === 0 ? undefined : { height: `${Math.max(12, (count / peak) * 32)}px` }}
            />
          </li>
        ))}
      </ol>
      <div className="mt-1 flex justify-between text-[0.65rem] text-muted-foreground">
        <span className="num">00</span>
        <span className="num">06</span>
        <span className="num">12</span>
        <span className="num">18</span>
        <span className="num">23</span>
      </div>
      {/* Table equivalent for anyone who cannot see the bars. */}
      <table className="sr-only">
        <caption>{t("adminAudit.user.hourStrip")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("adminAudit.user.hourCol")}</th>
            <th scope="col">{t("adminAudit.unit.events")}</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((count, hour) => (
            <tr key={`row-${hour}`}>
              <th scope="row">{String(hour).padStart(2, "0")}</th>
              <td>{count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted-foreground">{t("adminAudit.user.outOfHoursLegend")}</p>
    </section>
  );
}

export default function AuditUserTrailPage() {
  const navigate = useNavigate();
  const { userId = "" } = useParams<{ userId: string }>();

  const { params, preset, window, patch, clearAll, hasActiveFilters } = useAuditUrlFilters("d30");

  const actions = readList(params, "action");
  const labelLike = readText(params, "q");
  const onlyWithReason = readBool(params, "hasReason");
  const sensitiveOnly = readBool(params, "sensitive");

  // "Sensitive only" is a CLIENT-SIDE narrowing of the action filter into the
  // set §13.9 marks sensitive/critical, then sent to the server as an `in` list.
  // The filtering itself is still the database's.
  const effectiveActions = useMemo((): readonly string[] => {
    if (!sensitiveOnly) return actions;
    const sensitive: readonly string[] = auditActionValues.filter((a) => isSensitiveAction(a));
    if (actions.length === 0) return sensitive;
    return actions.filter((a) => sensitive.includes(a));
  }, [actions, sensitiveOnly]);

  const actionKey = effectiveActions.join(",");

  const filters: AuditFilters = useMemo(
    () => ({
      from: window.from,
      to: window.to,
      ...(effectiveActions.length > 0 ? { actions: effectiveActions } : {}),
      ...(labelLike !== "" ? { labelLike } : {}),
      ...(onlyWithReason ? { onlyWithReason: true } : {}),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [window.from, window.to, actionKey, labelLike, onlyWithReason],
  );

  const actor = useActorProfile(userId);
  const trail = useActorTrail(userId, filters);
  const rows = useMemo(() => flattenPages(trail.data), [trail.data]);

  // One constant actor: the column would repeat on every row (DR-46).
  const actorProfile = actor.data ?? null;
  const actorMap = useMemo(() => {
    const map = new Map<string, ActorProfile>();
    if (actorProfile !== null) map.set(actorProfile.id, actorProfile);
    return map;
  }, [actorProfile]);
  const columns = useMemo(() => auditColumns({ actors: actorMap, hideActor: true }), [actorMap]);

  const sensitiveCount = useMemo(
    () => rows.filter((r) => isSensitiveAction(r.action)).length,
    [rows],
  );
  const withoutReason = useMemo(
    () => rows.filter((r) => r.reason === null || r.reason.trim() === "").length,
    [rows],
  );
  const daysTouched = useMemo(() => new Set(rows.map((r) => r.ist_date)).size, [rows]);

  const chips: readonly ActiveChip[] = useMemo(() => {
    const out: ActiveChip[] = [];
    for (const a of actions) {
      out.push({
        id: `action:${a}`,
        label: t("adminAudit.chip.action", { value: actionLabel(a) }),
        onRemove: () => patch({ action: actions.filter((v) => v !== a) }),
      });
    }
    if (sensitiveOnly)
      out.push({
        id: "sensitive",
        label: t("adminAudit.filter.sensitiveOnly"),
        onRemove: () => patch({ sensitive: null }),
      });
    if (labelLike !== "")
      out.push({
        id: "q",
        label: t("adminAudit.chip.record", { value: labelLike }),
        onRemove: () => patch({ q: null }),
      });
    if (onlyWithReason)
      out.push({
        id: "hasReason",
        label: t("adminAudit.filter.hasReason"),
        onRemove: () => patch({ hasReason: null }),
      });
    return out;
  }, [actions, sensitiveOnly, labelLike, onlyWithReason, patch]);

  const displayName = actor.data?.full_name ?? t("adminAudit.actor.unknown");
  const scopeNumbers = t("adminAudit.user.scopeNumbers", {
    n: formatNumber(rows.length),
    from: fmtCivilDate(window.from),
    to: fmtCivilDate(window.to),
  });

  return (
    <div className="container py-6">
      <PageHeader
        icon={UserCog}
        title={t("adminAudit.user.title", { name: displayName })}
        subtitle={
          actor.data?.email !== undefined
            ? t("adminAudit.user.subtitleWithEmail", { email: actor.data.email })
            : t("adminAudit.user.subtitle")
        }
        actions={
          <Button variant="outline" asChild>
            <Link to="/admin/audit">
              <ArrowLeft className="mr-2 h-4 w-4" aria-hidden />
              {t("adminAudit.diff.backToTimeline")}
            </Link>
          </Button>
        }
      />

      {/* The other three registers for the same person. Linked, not embedded. */}
      <nav className="mb-4 flex flex-wrap gap-2" aria-label={t("adminAudit.user.otherRegisters")}>
        <Button variant="outline" size="sm" asChild>
          <Link to={`/admin/audit/sessions?actor=${userId}`}>
            <KeyRound className="mr-2 h-3.5 w-3.5" aria-hidden />
            {t("adminAudit.user.linkSessions")}
          </Link>
        </Button>
        <Button variant="outline" size="sm" asChild>
          <Link to={`/admin/audit/data-access?actor=${userId}`}>
            <Database className="mr-2 h-3.5 w-3.5" aria-hidden />
            {t("adminAudit.user.linkDataAccess")}
          </Link>
        </Button>
        <Button variant="outline" size="sm" asChild>
          <Link to={`/admin/audit/exports?actor=${userId}`}>
            <Download className="mr-2 h-3.5 w-3.5" aria-hidden />
            {t("adminAudit.user.linkExports")}
          </Link>
        </Button>
      </nav>

      <AuditFilterBar
        chips={chips}
        onClearAll={clearAll}
        resultLabel={loadedLabel(rows.length, trail.hasNextPage)}
      >
        <RangeFilter preset={preset} window={window} patch={patch} />
        <MultiSelectFilter
          label={t("adminAudit.filter.action")}
          options={auditActionValues.map((a) => ({ value: a, label: actionLabel(a) }))}
          selected={actions}
          onChange={(next) => patch({ action: next })}
          searchable
        />
        <TextFilter
          label={t("adminAudit.filter.record")}
          value={labelLike}
          onChange={(next) => patch({ q: next })}
          placeholder={t("adminAudit.filter.recordPlaceholder")}
        />
        <ToggleFilter
          label={t("adminAudit.filter.sensitiveOnly")}
          on={sensitiveOnly}
          onChange={(next) => patch({ sensitive: next })}
        />
        <ToggleFilter
          label={t("adminAudit.filter.hasReason")}
          on={onlyWithReason}
          onChange={(next) => patch({ hasReason: next })}
        />
      </AuditFilterBar>

      <StateBoundary
        loading={trail.isLoading}
        error={trail.error ?? undefined}
        onRetry={() => void trail.refetch()}
        partialError={actor.error ?? undefined}
        partialLabel={t("adminAudit.user.actorName")}
        skeletonRows={8}
      >
        {rows.length > 0 ? (
          <>
            <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <KpiTile
                label={t("adminAudit.user.kpi.events")}
                value={formatNumber(rows.length)}
                {...(trail.hasNextPage ? { hint: t("adminAudit.user.kpi.eventsMore") } : {})}
                explainer={{
                  formula: t("adminAudit.user.kpi.eventsFormula"),
                  numbers: scopeNumbers,
                }}
              />
              <KpiTile
                label={t("adminAudit.user.kpi.sensitive")}
                value={formatNumber(sensitiveCount)}
                tone={sensitiveCount > 0 ? "warn" : "neutral"}
                explainer={{
                  formula: t("adminAudit.user.kpi.sensitiveFormula"),
                  numbers: scopeNumbers,
                }}
              />
              <KpiTile
                label={t("adminAudit.user.kpi.noReason")}
                value={formatNumber(withoutReason)}
                tone={withoutReason > 0 ? "info" : "neutral"}
                explainer={{
                  formula: t("adminAudit.user.kpi.noReasonFormula"),
                  numbers: scopeNumbers,
                }}
              />
              <KpiTile
                label={t("adminAudit.user.kpi.days")}
                value={formatNumber(daysTouched)}
                explainer={{
                  formula: t("adminAudit.user.kpi.daysFormula"),
                  numbers: scopeNumbers,
                }}
              />
            </div>

            <div className="mb-4">
              <HourStrip rows={rows} />
            </div>
          </>
        ) : null}

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
                title={t("adminAudit.user.emptyFiltered.title", { name: displayName })}
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
                title={t("adminAudit.user.empty.title", { name: displayName })}
                hint={t("adminAudit.user.empty.hint")}
              />
            )
          }
        />

        <LoadMoreFooter
          loadedCount={rows.length}
          hasNextPage={trail.hasNextPage}
          isFetchingNextPage={trail.isFetchingNextPage}
          onLoadMore={() => void trail.fetchNextPage()}
          unitLabel={t("adminAudit.unit.events")}
        />
      </StateBoundary>
    </div>
  );
}
