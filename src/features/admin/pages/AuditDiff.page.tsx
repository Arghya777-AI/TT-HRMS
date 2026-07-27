/**
 * A-13.3 · /admin/audit/diff/:eventId — one audited change, in full.
 *
 * The point of this screen is that a single `audit_log` row is not a change: an
 * admin who edited four fields produced four rows. They are tied together by
 * `request_id`, which the write layer stamps from the `x-request-id` header on
 * every audited mutation, so this page shows the WHOLE edit and marks which
 * field-change you arrived on.
 *
 * (§13.1 specifies an `event_group_id` column for this. It is not in the deployed
 * schema; `request_id` is the deployed grouping key and carries the same meaning
 * — one statement, one id — so it is what the grouping uses.)
 *
 * The redacted case: `is_redacted` rows carry the literal `***`. §13.3 asks for a
 * super-admin `Reveal` that writes `data_access.audit_value.revealed`. No such
 * RPC is deployed (`reveal_employee_statutory` / `_bank_account` / `_salary` /
 * `_identity_document` / `_face_match_candidates` are the five that exist), so
 * this screen states plainly that the value was never sent to the browser and
 * points at the record's own reveal path instead of offering a button that
 * cannot work.
 *
 * @route /admin/audit/diff/:eventId
 */
import { useMemo, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, FileDiff, Info, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtDateTime } from "@/lib/datetime";
import { dash, EM_DASH } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { AuditRow } from "../api/audit.api";
import {
  actionChip,
  actionLabel,
  dayDelta,
  entityLabel,
  fieldLabel,
  groupHash,
  isFirstSet,
  moneyDelta,
  roleLabel,
  shortHash,
  sourceLabel,
} from "../audit/display";
import { useActorNames, useAuditEvent, useAuditEventGroup } from "../audit/hooks";
import { AuditValue } from "../audit/components/AuditValue";
import { resolveActorName } from "../audit/components/auditColumns";

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid gap-0.5 py-2 sm:grid-cols-[11rem_1fr] sm:gap-3">
      <dt className="text-xs text-muted-foreground sm:text-sm">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

/** One field-change block: label, old → new, and the derived delta. */
function FieldChange({ row, highlight }: { readonly row: AuditRow; readonly highlight: boolean }) {
  const delta =
    moneyDelta(row.field_name, row.old_value, row.new_value) ??
    dayDelta(row.field_name, row.old_value, row.new_value);
  const firstSet = isFirstSet(row.old_value, row.new_value);

  return (
    <li
      className={
        highlight
          ? "rounded-md border border-primary/50 bg-primary/5 p-3"
          : "rounded-md border p-3"
      }
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">{fieldLabel(row.field_name)}</p>
        <span className="flex items-center gap-2">
          {firstSet ? (
            <span className="rounded bg-info/15 px-1.5 py-0.5 text-xs font-medium text-info">
              {t("adminAudit.diff.firstSet")}
            </span>
          ) : null}
          {highlight ? (
            <span className="text-xs text-muted-foreground">{t("adminAudit.diff.thisEvent")}</span>
          ) : null}
        </span>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div className="rounded border bg-muted/30 p-2">
          <p className="text-xs text-muted-foreground">{t("adminAudit.diff.before")}</p>
          <div className="mt-1">
            <AuditValue
              fieldName={row.field_name}
              value={row.old_value}
              redacted={row.is_redacted}
              side="old"
            />
          </div>
        </div>
        <div className="rounded border bg-card p-2">
          <p className="text-xs text-muted-foreground">{t("adminAudit.diff.after")}</p>
          <div className="mt-1">
            <AuditValue
              fieldName={row.field_name}
              value={row.new_value}
              redacted={row.is_redacted}
              side="new"
            />
          </div>
        </div>
      </div>

      {delta !== null ? (
        <p className="num mt-2 text-xs text-muted-foreground">
          {t("adminAudit.diff.delta", { value: delta })}
        </p>
      ) : null}

      {row.is_redacted ? (
        <p className="mt-2 flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/5 p-2 text-xs">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
          <span>{t("adminAudit.diff.redactedExplainer")}</span>
        </p>
      ) : null}
    </li>
  );
}

export default function AuditDiffPage() {
  const { eventId = "" } = useParams<{ eventId: string }>();

  const event = useAuditEvent(eventId);
  const row = event.data ?? null;
  const group = useAuditEventGroup(row?.request_id ?? null);

  const actorIds = useMemo(() => (row?.actor_id !== null && row?.actor_id !== undefined ? [row.actor_id] : []), [row]);
  const actorNames = useActorNames(actorIds);

  // The whole edit: the sibling rows when the group resolved, otherwise just this
  // one. Never a silent "the other three fields don't exist".
  const changes: readonly AuditRow[] = useMemo(() => {
    if (row === null) return [];
    const siblings = group.data ?? [];
    return siblings.length > 0 ? siblings : [row];
  }, [row, group.data]);

  const actorName = row !== null ? resolveActorName(row, actorNames.data) : EM_DASH;

  return (
    <div className="container py-6">
      <PageHeader
        icon={FileDiff}
        title={t("adminAudit.diff.title")}
        subtitle={t("adminAudit.diff.subtitle")}
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
        loading={event.isLoading}
        error={event.error ?? undefined}
        onRetry={() => void event.refetch()}
        isEmpty={event.isSuccess && row === null}
        empty={
          <EmptyState
            icon={ShieldCheck}
            title={t("adminAudit.diff.notFound.title")}
            hint={t("adminAudit.diff.notFound.hint")}
            action={
              <Button variant="outline" asChild>
                <Link to="/admin/audit">{t("adminAudit.diff.backToTimeline")}</Link>
              </Button>
            }
          />
        }
        partialError={actorNames.error ?? group.error ?? undefined}
        partialLabel={t("adminAudit.diff.partialLabel")}
        skeletonRows={5}
      >
        {row !== null ? (
          <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
            {/* Left: the change itself */}
            <div className="min-w-0 space-y-4">
              <section className="rounded-lg border bg-card p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip status={row.action} map={actionChip(row.action)} />
                  <span className="num text-sm text-muted-foreground">
                    {fmtDateTime(row.occurred_at)}
                  </span>
                </div>
                <p className="mt-3 text-base leading-snug">
                  {t("adminAudit.diff.headline", {
                    actor: actorName,
                    action: actionLabel(row.action).toLowerCase(),
                    subject:
                      row.entity_label !== null && row.entity_label.trim() !== ""
                        ? row.entity_label
                        : entityLabel(row.entity_table),
                  })}
                </p>
                {row.reason !== null && row.reason.trim() !== "" ? (
                  <blockquote className="mt-3 border-l-2 border-primary/40 pl-3 text-sm italic">
                    {row.reason}
                  </blockquote>
                ) : (
                  <p className="mt-3 text-sm text-muted-foreground">
                    {t("adminAudit.diff.noReason")}
                  </p>
                )}
              </section>

              <section>
                <h2 className="mb-2 font-display text-lg font-semibold">
                  {changes.length > 1
                    ? t("adminAudit.diff.fieldsPlural", { n: changes.length })
                    : t("adminAudit.diff.fieldsSingular")}
                </h2>
                <ul className="space-y-2">
                  {changes.map((change) => (
                    <FieldChange key={change.id} row={change} highlight={change.id === row.id} />
                  ))}
                </ul>
                {changes.length > 1 ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t("adminAudit.diff.groupedBy")}
                  </p>
                ) : null}
              </section>

              {/* §13.3 asks for "±5 events context". `AuditFilters` filters on
                  `ist_date`, not on a `seq` neighbourhood, so the honest version
                  is the same day's timeline rather than a fabricated window. */}
              <section className="rounded-lg border bg-card p-4">
                <h2 className="font-display text-base font-semibold">
                  {t("adminAudit.diff.context")}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("adminAudit.diff.contextHint")}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" asChild>
                    <Link to={`/admin/audit?range=custom&from=${row.ist_date}&to=${row.ist_date}`}>
                      {t("adminAudit.diff.contextDay")}
                    </Link>
                  </Button>
                  {row.actor_id !== null ? (
                    <Button variant="outline" size="sm" asChild>
                      <Link
                        to={`/admin/audit/user/${row.actor_id}?range=custom&from=${row.ist_date}&to=${row.ist_date}`}
                      >
                        {t("adminAudit.diff.contextActor")}
                      </Link>
                    </Button>
                  ) : null}
                </div>
              </section>
            </div>

            {/* Right: provenance — who, from where, and where it sits in the chain */}
            <aside className="space-y-4">
              <section className="rounded-lg border bg-card p-4">
                <h2 className="mb-1 font-display text-base font-semibold">
                  {t("adminAudit.diff.who")}
                </h2>
                <dl className="divide-y">
                  <Row label={t("adminAudit.col.actor")}>
                    {row.actor_id !== null ? (
                      <Link
                        to={`/admin/audit/user/${row.actor_id}`}
                        className="rounded underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {actorName}
                      </Link>
                    ) : (
                      actorName
                    )}
                  </Row>
                  <Row label={t("adminAudit.field.actorRole")}>{roleLabel(row.actor_role)}</Row>
                  <Row label={t("adminAudit.field.source")}>{sourceLabel(row.actor_source)}</Row>
                  <Row label={t("adminAudit.field.ip")}>
                    <span className="font-mono text-xs">{dash(row.ip)}</span>
                  </Row>
                  <Row label={t("adminAudit.field.device")}>
                    <span className="font-mono text-xs">{dash(row.device_id)}</span>
                  </Row>
                  {row.impersonated_by !== null ? (
                    <Row label={t("adminAudit.field.impersonatedBy")}>
                      <span className="font-medium text-destructive">
                        {t("adminAudit.flag.impersonated")}
                      </span>
                    </Row>
                  ) : null}
                  {row.on_behalf_of !== null ? (
                    <Row label={t("adminAudit.field.onBehalfOf")}>
                      <span className="font-mono text-xs">{row.on_behalf_of}</span>
                    </Row>
                  ) : null}
                </dl>
              </section>

              <section className="rounded-lg border bg-card p-4">
                <h2 className="mb-1 font-display text-base font-semibold">
                  {t("adminAudit.diff.record")}
                </h2>
                <dl className="divide-y">
                  <Row label={t("adminAudit.field.entityType")}>{entityLabel(row.entity_table)}</Row>
                  <Row label={t("adminAudit.field.entity")}>
                    {row.entity_id !== null ? (
                      <Link
                        to={`/admin/audit/entity/${encodeURIComponent(row.entity_table)}/${row.entity_id}`}
                        className="rounded underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {row.entity_label ?? t("adminAudit.diff.viewHistory")}
                      </Link>
                    ) : (
                      dash(row.entity_label)
                    )}
                  </Row>
                  {row.approval_request_id !== null ? (
                    <Row label={t("adminAudit.field.approval")}>
                      <span className="font-mono text-xs">{row.approval_request_id}</span>
                    </Row>
                  ) : null}
                </dl>
              </section>

              {/* The chain position. This is the tamper-evidence half of the row:
                  row_hash covers prev_hash, so quoting both is what lets an
                  auditor tie this event to the day's seal on /admin/audit/integrity. */}
              <section className="rounded-lg border bg-card p-4">
                <h2 className="mb-1 font-display text-base font-semibold">
                  {t("adminAudit.diff.chain")}
                </h2>
                <dl className="divide-y">
                  <Row label={t("adminAudit.field.seq")}>
                    <span className="num">{row.seq}</span>
                  </Row>
                  <Row label={t("adminAudit.field.rowHash")}>
                    <span className="break-all font-mono text-xs">{groupHash(row.row_hash)}</span>
                  </Row>
                  <Row label={t("adminAudit.field.prevHash")}>
                    <span className="break-all font-mono text-xs">
                      {shortHash(row.prev_hash)}
                      {row.prev_hash !== null ? "…" : ""}
                    </span>
                  </Row>
                  <Row label={t("adminAudit.field.requestId")}>
                    <span className="break-all font-mono text-xs">{dash(row.request_id)}</span>
                  </Row>
                </dl>
                <Button variant="outline" size="sm" className="mt-3 w-full" asChild>
                  <Link to={`/admin/audit/integrity?seal=${row.ist_date}`}>
                    {t("adminAudit.diff.checkSeal")}
                  </Link>
                </Button>
              </section>
            </aside>
          </div>
        ) : null}
      </StateBoundary>
    </div>
  );
}
