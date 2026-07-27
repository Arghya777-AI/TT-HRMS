/**
 * auditColumns — the ONE column set behind the Audit Timeline, the Entity History
 * and the User Activity Trail.
 *
 * They are the same rows from the same table, so they get the same columns. Three
 * near-identical column definitions is how a "Field" column ends up formatting a
 * date differently on one screen than another.
 */
import { Link } from "react-router-dom";
import { EyeOff, Fingerprint } from "lucide-react";
import type { DataGridColumn } from "@/shared/ui/DataGrid";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtDateTime } from "@/lib/datetime";
import { dash, EM_DASH } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { AuditRow } from "../../api/audit.api";
import type { ActorProfile } from "../../api/audit-registers.api";
import {
  actionChip,
  actorLabel,
  auditSentence,
  dayDelta,
  entityLabel,
  fieldLabel,
  moneyDelta,
  roleLabel,
  sourceLabel,
} from "../display";
import { AuditChange } from "./AuditValue";

export interface AuditColumnOptions {
  /** Resolved actor names for the loaded page; falls back to the row's email. */
  readonly actors: ReadonlyMap<string, ActorProfile> | undefined;
  /** Drop the actor column on the User Activity Trail — it is constant there. */
  readonly hideActor?: boolean;
  /** Drop the entity column on the Entity History — it is constant there. */
  readonly hideEntity?: boolean;
}

export function resolveActorName(
  row: Pick<AuditRow, "actor_id" | "actor_email" | "actor_source">,
  actors: ReadonlyMap<string, ActorProfile> | undefined,
): string {
  const profile = row.actor_id !== null ? actors?.get(row.actor_id) : undefined;
  return actorLabel({
    name: profile?.full_name ?? null,
    email: row.actor_email,
    actorId: row.actor_id,
    source: row.actor_source,
  });
}

export function auditColumns(opts: AuditColumnOptions): DataGridColumn<AuditRow>[] {
  const { actors, hideActor = false, hideEntity = false } = opts;

  const columns: DataGridColumn<AuditRow>[] = [
    {
      key: "occurred_at",
      header: t("adminAudit.col.when"),
      width: "12rem",
      sortable: true,
      sortValue: (row) => row.occurred_at,
      // `ist_timestamp` is the database's own generated IST wall clock. It is
      // rendered through fmtDateTime on `occurred_at` so the mandatory "IST"
      // suffix and the one app-wide timestamp format both apply (§6).
      render: (row) => <span className="num whitespace-nowrap">{fmtDateTime(row.occurred_at)}</span>,
    },
    {
      key: "action",
      header: t("adminAudit.col.action"),
      width: "10rem",
      render: (row) => <StatusChip status={row.action} map={actionChip(row.action)} />,
    },
  ];

  if (!hideActor) {
    columns.push({
      key: "actor",
      header: t("adminAudit.col.actor"),
      width: "13rem",
      render: (row) => {
        const name = resolveActorName(row, actors);
        const body = (
          <span className="flex flex-col leading-tight">
            <span className="truncate">{name}</span>
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
    });
  }

  if (!hideEntity) {
    columns.push({
      key: "entity",
      header: t("adminAudit.col.entity"),
      hideBelow: "md",
      render: (row) => {
        const label =
          row.entity_label !== null && row.entity_label.trim() !== ""
            ? row.entity_label
            : entityLabel(row.entity_table);
        const type = entityLabel(row.entity_table);
        const body = (
          <span className="flex flex-col leading-tight">
            <span className="truncate">{label}</span>
            <span className="truncate text-xs text-muted-foreground">{type}</span>
          </span>
        );
        if (row.entity_id === null) return body;
        return (
          <span onClick={(e) => e.stopPropagation()}>
            <Link
              to={`/admin/audit/entity/${encodeURIComponent(row.entity_table)}/${row.entity_id}`}
              className="rounded underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {body}
            </Link>
          </span>
        );
      },
    });
  }

  columns.push(
    {
      key: "field_name",
      header: t("adminAudit.col.field"),
      width: "11rem",
      hideBelow: "lg",
      render: (row) => fieldLabel(row.field_name),
    },
    {
      key: "change",
      header: t("adminAudit.col.change"),
      render: (row) => {
        if (row.old_value === null && row.new_value === null) {
          return <span className="text-muted-foreground">{EM_DASH}</span>;
        }
        const delta =
          moneyDelta(row.field_name, row.old_value, row.new_value) ??
          dayDelta(row.field_name, row.old_value, row.new_value);
        return (
          <AuditChange
            fieldName={row.field_name}
            oldValue={row.old_value}
            newValue={row.new_value}
            redacted={row.is_redacted}
            delta={delta}
          />
        );
      },
    },
    {
      key: "reason",
      header: t("adminAudit.col.reason"),
      hideBelow: "lg",
      render: (row) =>
        row.reason === null || row.reason.trim() === "" ? (
          <span className="text-muted-foreground">{t("adminAudit.reason.none")}</span>
        ) : (
          <span className="line-clamp-2 text-sm" title={row.reason}>
            {row.reason}
          </span>
        ),
    },
    {
      key: "flags",
      header: t("adminAudit.col.flags"),
      width: "6rem",
      align: "center",
      hideBelow: "lg",
      render: (row) => (
        <span className="inline-flex items-center gap-1.5">
          {row.is_redacted ? (
            <EyeOff
              className="h-3.5 w-3.5 text-muted-foreground"
              aria-label={t("adminAudit.value.redactedHint")}
            />
          ) : null}
          {row.impersonated_by !== null ? (
            <Fingerprint
              className="h-3.5 w-3.5 text-destructive"
              aria-label={t("adminAudit.flag.impersonated")}
            />
          ) : null}
          {!row.is_redacted && row.impersonated_by === null ? dash(null) : null}
        </span>
      ),
    },
  );

  return columns;
}

/** The sentence §13.2 wants, for the mobile card and the diff header. */
export function auditRowSentence(
  row: AuditRow,
  actors: ReadonlyMap<string, ActorProfile> | undefined,
): string {
  return auditSentence({
    action: row.action,
    entity_table: row.entity_table,
    entity_label: row.entity_label,
    field_name: row.field_name,
    actorName: resolveActorName(row, actors),
  });
}
