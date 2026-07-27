/**
 * §1 · /admin/alerts — the full alert feed.
 *
 * WHAT AN ALERT IS HERE, stated plainly because it differs from spec-admin §2.3:
 * there is no `alerts` table on this backend, so there is no assignee, no
 * acknowledgement, no snooze and no resolution note to write. The feed is
 * `v_exception_queue` — the admin's morning list — which is SELF-CLEARING: a row
 * exists exactly as long as the underlying problem does. That is a stronger
 * guarantee than an acknowledgement flag (nobody can mark a real problem read),
 * and the banner says so rather than offering buttons that would write nowhere.
 *
 * Every row therefore does two things: it links to the screen that can fix the
 * problem, and — for a flagged gate scan, the one exception whose remedy lives in
 * this feed — it offers the audited void. Punches are immutable evidence, so the
 * remedy is void-not-delete, it goes through the `void-punch` edge function with
 * an idempotency key, and it asks for a typed reason of at least 15 characters
 * (D-21). The reason is never invented for the admin.
 *
 * Filters live in the URL (D-25), so a link to "critical only" is a link.
 *
 * @route /admin/alerts
 */
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Bell, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { SENSITIVE_REASON_LENGTH } from "@/shared/api/query";
import { qk } from "@/shared/api/keys";
import { useAuditedMutation } from "@/shared/hooks/useAuditedMutation";
import { useAuth } from "@/app/auth/AuthProvider";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { voidPunch } from "../api/attendance.api";
import {
  EXCEPTION_KINDS,
  EXCEPTION_SEVERITIES,
  alertRowKey,
  newIdempotencyKey,
  type AlertFilters,
  type ExceptionRow,
} from "../api/command.api";
import {
  ADMIN_ROUTES,
  SEVERITY_CHIP,
  alertKindLabel,
  alertKindOptions,
  alertRoute,
  isVoidablePunch,
} from "../command-vocab";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField } from "../components/Field";
import { useAlertCount, useAlertFeed } from "../hooks/useCommandCentre";
import { useEmployeeLabels, type EmployeeLabelMap } from "../hooks/useEmployeeLabels";
import { useReasonPrompt } from "../hooks/useReasonPrompt";

/** Hard cap on one page of the feed; the header states it when it bites. */
const FEED_LIMIT = 200;

/** A URL filter value, but only if the server can actually emit it. */
function asKnown(value: string | null, allowed: readonly string[]): string {
  return value !== null && allowed.includes(value) ? value : "";
}

interface VoidTarget {
  readonly punchId: string;
  readonly description: string;
  /** Generated once when the dialog opens, reused across retries (409 = success). */
  readonly idempotencyKey: string;
}

export default function AlertFeedPage() {
  const [params, setParams] = useSearchParams();
  // A hand-edited or stale link can carry a value the view never emits. Treating
  // it as unset beats sending a predicate that matches nothing and then blaming
  // the filters — and it keeps the <select> showing a value it actually offers.
  const severity = asKnown(params.get("severity"), EXCEPTION_SEVERITIES);
  const kind = asKnown(params.get("kind"), EXCEPTION_KINDS);

  const filters: AlertFilters = useMemo(
    () => ({
      ...(severity !== "" ? { severities: [severity] } : {}),
      ...(kind !== "" ? { kinds: [kind] } : {}),
    }),
    [severity, kind],
  );
  const hasFilters = severity !== "" || kind !== "";

  const feed = useAlertFeed(filters, FEED_LIMIT);
  const count = useAlertCount(filters);
  const labels = useEmployeeLabels();
  const auth = useAuth();

  const prompt = useReasonPrompt<VoidTarget>();
  const [saved, setSaved] = useState<string | null>(null);

  const voidWrite = useAuditedMutation<Awaited<ReturnType<typeof voidPunch>>, VoidTarget>({
    mutationFn: (input, reason) =>
      voidPunch({ punchId: input.punchId, voidReasonCode: "admin_void" }, reason, input.idempotencyKey),
    // Widest correct prefix: the exception feed, the punch log and every
    // attendance count on the Command Centre all hang off this key.
    invalidate: [qk.admin.attendanceAll()],
    minReasonLength: SENSITIVE_REASON_LENGTH,
    onSuccess: () => {
      setSaved(t("admin.alert.void.done"));
      prompt.close();
    },
  });

  function setFilter(name: "severity" | "kind", value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: true });
  }

  function clearFilters(): void {
    const next = new URLSearchParams(params);
    next.delete("severity");
    next.delete("kind");
    setParams(next, { replace: true });
  }

  const rows = feed.data ?? [];
  const total = count.error === null ? count.data : undefined;
  const columns = buildColumns(labels.data, (row) => {
    setSaved(null);
    prompt.ask({
      punchId: row.entity_id,
      description: row.description,
      idempotencyKey: newIdempotencyKey(),
    });
  });

  return (
    <>
      <PageHeader
        icon={Bell}
        title={t("admin.alert.title")}
        subtitle={t("admin.alert.subtitle")}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to={ADMIN_ROUTES.exceptions}>{t("admin.alert.openExceptions")}</Link>
          </Button>
        }
      />

      <div className="space-y-3">
        <Notice tone="info">{t("admin.alert.derivedNote")}</Notice>

        {saved !== null ? (
          <Notice
            tone="success"
            action={
              <Button variant="ghost" size="sm" onClick={() => setSaved(null)}>
                {t("common.close")}
              </Button>
            }
          >
            {saved}
          </Notice>
        ) : null}

        {voidWrite.isError && !prompt.isOpen && voidWrite.userMessage !== null ? (
          <Notice tone="error">{voidWrite.userMessage}</Notice>
        ) : null}

        {rows.length >= FEED_LIMIT ? (
          <Notice tone="warning">
            {t("admin.alert.capped", { limit: formatNumber(FEED_LIMIT) })}
          </Notice>
        ) : null}

        <StateBoundary
          loading={feed.isPending}
          error={feed.error}
          onRetry={() => void feed.refetch()}
          isEmpty={rows.length === 0}
          empty={
            hasFilters ? (
              <EmptyState
                icon={Bell}
                title={t("admin.alert.empty.filtered.title")}
                hint={t("admin.alert.empty.filtered.hint")}
                action={
                  <Button variant="outline" size="sm" onClick={clearFilters}>
                    {t("admin.alert.clearFilters")}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={Bell}
                title={t("admin.alert.empty.title")}
                hint={t("admin.alert.empty.hint")}
              />
            )
          }
          partialError={labels.error}
          partialLabel={t("admin.alert.partial.people")}
          skeletonRows={6}
        >
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={alertRowKey}
            pageSize={25}
            toolbar={
              <div className="flex flex-wrap items-end gap-3">
                <SelectField
                  label={t("admin.alert.filter.severity")}
                  value={severity}
                  options={EXCEPTION_SEVERITIES.map((s) => ({
                    value: s,
                    label: SEVERITY_CHIP[s]?.label ?? s,
                  }))}
                  placeholder={t("admin.alert.filter.allSeverities")}
                  onChange={(value) => setFilter("severity", value)}
                  className="w-48"
                />
                <SelectField
                  label={t("admin.alert.filter.kind")}
                  value={kind}
                  options={alertKindOptions(EXCEPTION_KINDS)}
                  placeholder={t("admin.alert.filter.allKinds")}
                  onChange={(value) => setFilter("kind", value)}
                  className="w-64"
                />
                {hasFilters ? (
                  <Button variant="ghost" size="sm" onClick={clearFilters}>
                    {t("admin.alert.clearFilters")}
                  </Button>
                ) : null}
                <p className="ml-auto text-sm text-muted-foreground">
                  {total === undefined
                    ? t("admin.cc.alerts.countUnknown")
                    : t("admin.alert.matching", { total: formatNumber(total) })}
                </p>
              </div>
            }
          />
        </StateBoundary>
      </div>

      <ReasonDialog
        open={prompt.isOpen}
        title={t("admin.alert.void.title")}
        description={
          prompt.target === null
            ? t("admin.alert.void.description")
            : t("admin.alert.void.descriptionNamed", { what: prompt.target.description })
        }
        actorName={auth.employee?.displayName ?? null}
        minLength={SENSITIVE_REASON_LENGTH}
        confirmLabel={t("admin.alert.void.confirm")}
        pending={voidWrite.isPending}
        errorMessage={voidWrite.userMessage}
        onConfirm={(reason) => {
          if (prompt.target !== null) voidWrite.save(prompt.target, reason);
        }}
        onCancel={() => {
          voidWrite.reset();
          prompt.close();
        }}
      />
    </>
  );
}

function buildColumns(
  labels: EmployeeLabelMap | undefined,
  onVoid: (row: ExceptionRow) => void,
): DataGridColumn<ExceptionRow>[] {
  return [
    {
      key: "severity",
      header: t("admin.alert.col.severity"),
      width: "8.5rem",
      sortable: true,
      render: (row) => <StatusChip status={row.severity} map={SEVERITY_CHIP} />,
    },
    {
      key: "exception_kind",
      header: t("admin.alert.col.kind"),
      width: "12rem",
      sortable: true,
      sortValue: (row) => alertKindLabel(row.exception_kind),
      render: (row) => alertKindLabel(row.exception_kind),
    },
    {
      key: "description",
      header: t("admin.alert.col.what"),
      render: (row) => <span className="text-sm">{row.description}</span>,
    },
    {
      key: "employee_id",
      header: t("admin.alert.col.person"),
      hideBelow: "md",
      width: "12rem",
      render: (row) => {
        if (row.employee_id === null) return <span className="text-muted-foreground">{t("common.empty")}</span>;
        const label = labels?.get(row.employee_id) ?? null;
        if (label === null) {
          return (
            <span className="text-sm text-muted-foreground">
              {labels === undefined ? t("common.empty") : t("admin.person.outOfScope")}
            </span>
          );
        }
        return <PersonCell name={label.name} code={label.code} secondary={label.department} />;
      },
    },
    {
      key: "ist_date",
      header: t("admin.alert.col.date"),
      width: "8rem",
      hideBelow: "sm",
      sortable: true,
      sortValue: (row) => row.ist_date ?? "",
      render: (row) => fmtCivilDate(row.ist_date),
    },
    {
      key: "occurred_at",
      header: t("admin.alert.col.raised"),
      width: "12rem",
      hideBelow: "lg",
      sortable: true,
      render: (row) => fmtDateTime(row.occurred_at),
    },
    {
      key: "actions",
      header: t("admin.alert.col.action"),
      align: "right",
      width: "13rem",
      render: (row) => {
        const label = row.employee_id === null ? null : labels?.get(row.employee_id) ?? null;
        return (
          <span className="flex items-center justify-end gap-2">
            {isVoidablePunch(row) ? (
              <Button variant="outline" size="sm" onClick={() => onVoid(row)}>
                <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
                {t("admin.alert.void.action")}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" asChild>
              <Link to={alertRoute(row, label?.code ?? null)}>{t("admin.alert.open")}</Link>
            </Button>
          </span>
        );
      },
    },
  ];
}
