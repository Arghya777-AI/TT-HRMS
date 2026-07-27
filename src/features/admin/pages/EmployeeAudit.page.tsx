/**
 * §2 · /admin/people/:code/audit — every field-level change ever made to one
 * employee record.
 *
 * This is the screen that answers "who changed this, when, and why". It reads
 * `v_audit_trail_employee`, which is one row PER CHANGED FIELD with the old and
 * new value, the actor, the actor's role at the time, the source, and the reason
 * the actor typed. Nothing here is reconstructed in the browser — the view
 * already renders the IST timestamp, so even the clock is the server's.
 *
 * Keyset pagination, not offset: `audit_log` is append-only and is being written
 * while an auditor scrolls it, and OFFSET paging over a growing table repeats and
 * skips rows. On an evidence surface that is not a cosmetic bug.
 *
 * Redacted rows are shown as redacted rather than hidden. A gap in an audit trail
 * is indistinguishable from tampering; a row that says "value withheld" is not.
 *
 * @route /admin/people/:code/audit
 */
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { TextField } from "../components/Field";
import { Notice } from "../components/Notice";
import {
  EMPLOYEE_AUDIT_PAGE_SIZE,
  flattenAudit,
  useAdminEmployee,
  useEmployeeAudit,
  type EmployeeAuditFilters,
} from "../hooks/usePeople";
import type { EmployeeAuditRow } from "../api/audit.api";

/** An audit value is `unknown` by design — render it without pretending. */
function renderValue(value: unknown, redacted: boolean): string {
  if (redacted) return t("admin.pAudit.redacted");
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value === "" ? "—" : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export default function EmployeeAuditPage() {
  const { code = "" } = useParams<{ code: string }>();
  const employee = useAdminEmployee(code);
  const employeeId = employee.data?.id ?? null;

  const [fieldName, setFieldName] = useState("");
  const [onlyWithReason, setOnlyWithReason] = useState(false);

  const filters = useMemo<EmployeeAuditFilters>(
    () => ({
      ...(fieldName.trim() !== "" ? { fieldName: fieldName.trim() } : {}),
      ...(onlyWithReason ? { onlyWithReason: true } : {}),
    }),
    [fieldName, onlyWithReason],
  );

  const trail = useEmployeeAudit(employeeId, filters);
  const rows = flattenAudit(trail.data);
  const hasFilter = fieldName.trim() !== "" || onlyWithReason;

  const columns: DataGridColumn<EmployeeAuditRow>[] = [
    {
      key: "occurred_at_ist",
      header: t("admin.pAudit.col.when"),
      width: "12rem",
      // Pre-rendered IST by the view — never re-derived here.
      render: (r) => <span className="num">{r.occurred_at_ist}</span>,
    },
    {
      key: "actor_name",
      header: t("admin.pAudit.col.who"),
      width: "12rem",
      render: (r) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium">{dash(r.actor_name)}</span>
          <span className="text-xs text-muted-foreground">
            {dash(r.actor_role)} · {r.actor_source}
          </span>
        </span>
      ),
    },
    {
      key: "action",
      header: t("admin.pAudit.col.action"),
      width: "7rem",
      render: (r) => <span className="text-xs uppercase tracking-wide">{r.action}</span>,
    },
    {
      key: "field_name",
      header: t("admin.pAudit.col.field"),
      render: (r) => dash(r.field_name),
    },
    {
      key: "old_value",
      header: t("admin.pAudit.col.from"),
      hideBelow: "md",
      render: (r) => (
        <span className="text-muted-foreground">{renderValue(r.old_value, r.is_redacted)}</span>
      ),
    },
    {
      key: "new_value",
      header: t("admin.pAudit.col.to"),
      render: (r) => (
        <span className="font-medium">{renderValue(r.new_value, r.is_redacted)}</span>
      ),
    },
    {
      key: "reason",
      header: t("admin.pAudit.col.reason"),
      hideBelow: "lg",
      render: (r) => dash(r.reason),
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={ShieldCheck}
        title={t("admin.pAudit.title")}
        subtitle={
          employee.data !== undefined
            ? t("admin.pAudit.subtitle", {
                name: employee.data.display_name,
                code: employee.data.employee_code,
              })
            : t("admin.pAudit.subtitlePlain")
        }
        actions={
          <Button asChild variant="ghost">
            <Link to={`/admin/people/${code}`}>
              <ArrowLeft className="mr-2 size-4" aria-hidden />
              {t("admin.pAudit.backToRecord")}
            </Link>
          </Button>
        }
      />

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-3">
        <TextField
          label={t("admin.pAudit.filter.field")}
          value={fieldName}
          onChange={setFieldName}
          placeholder={t("admin.pAudit.filter.fieldPlaceholder")}
          hint={t("admin.pAudit.filter.fieldHint")}
        />
        <div className="flex items-end gap-2">
          <Button
            type="button"
            variant={onlyWithReason ? "default" : "outline"}
            onClick={() => setOnlyWithReason((v) => !v)}
            aria-pressed={onlyWithReason}
          >
            {t("admin.pAudit.filter.withReason")}
          </Button>
          {hasFilter ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setFieldName("");
                setOnlyWithReason(false);
              }}
            >
              {t("admin.pAudit.filter.clear")}
            </Button>
          ) : null}
        </div>
        <div className="flex items-end justify-end">
          <p className="text-sm text-muted-foreground">
            {t("admin.pAudit.loaded", { n: formatNumber(rows.length) })}
          </p>
        </div>
      </div>

      <div className="mt-4">
        <StateBoundary
          loading={trail.isPending || employee.isPending}
          error={trail.error ?? employee.error}
          onRetry={() => void trail.refetch()}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              icon={ShieldCheck}
              title={
                hasFilter
                  ? t("admin.pAudit.empty.filtered.title")
                  : t("admin.pAudit.empty.title")
              }
              hint={
                hasFilter ? t("admin.pAudit.empty.filtered.hint") : t("admin.pAudit.empty.hint")
              }
            />
          }
        >
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            pageSize={EMPLOYEE_AUDIT_PAGE_SIZE}
          />

          {trail.hasNextPage ? (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                onClick={() => void trail.fetchNextPage()}
                disabled={trail.isFetchingNextPage}
              >
                {trail.isFetchingNextPage
                  ? t("admin.pAudit.loadingMore")
                  : t("admin.pAudit.loadMore")}
              </Button>
            </div>
          ) : null}
        </StateBoundary>
      </div>

      <div className="mt-4">
        <Notice tone="info">{t("admin.pAudit.footnote")}</Notice>
      </div>
    </div>
  );
}
