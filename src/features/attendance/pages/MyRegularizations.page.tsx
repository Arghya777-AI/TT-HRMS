/**
 * E-04 · /me/regularizations — my correction requests and where each one stands.
 *
 * Read-only over `attendance_regularizations` (own rows by RLS) plus the
 * server-resolved monthly quota. Nothing on this page is computed: the quota
 * counts the exact rows it also lists, and the status vocabulary is the DB enum
 * rendered through `StatusChip`, never a bare code (DR-53).
 *
 * @route /me/regularizations
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { ClipboardList, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { t } from "@/shared/i18n/en";
import { fmtCivilDate, fmtDateTime, fmtMonth, fmtTime, nowIstDate } from "@/lib/datetime";
import { dash } from "@/lib/format";
import {
  regularizationRef,
  type Regularization,
  type RegularizationKind,
} from "../api/regularizations.api";
import {
  useMyRegularizations,
  useRegularizationQuota,
  useWithdrawRegularization,
} from "../hooks/useRegularizations";

const STATUS_MAP: Record<string, StatusChipEntry> = {
  draft: { label: "Draft", tone: "neutral" },
  pending: { label: "With your manager", tone: "warn" },
  approved: { label: "Approved", tone: "success" },
  applied: { label: "Applied to the day", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
  cancelled: { label: "Withdrawn", tone: "neutral" },
};

const KIND_KEY = {
  missed_in: "reg.type.missed_in",
  missed_out: "reg.type.missed_out",
  missed_both: "reg.type.missed_both",
  wrong_time: "reg.type.wrong_time",
  marked_absent: "reg.type.marked_absent",
  on_duty: "reg.type.on_duty",
  work_from_home: "reg.type.work_from_home",
  shift_mismatch: "reg.type.shift_mismatch",
  break_correction: "reg.type.break_correction",
} as const;

export function kindLabel(kind: RegularizationKind): string {
  return t(KIND_KEY[kind]);
}

/** The requested change, in words. Times only — no derived durations. */
function requestedChange(row: Regularization): string {
  const parts: string[] = [];
  if (row.requested_first_in_at !== null) parts.push(`${t("reg.form.in")} ${fmtTime(row.requested_first_in_at)}`);
  if (row.requested_last_out_at !== null) parts.push(`${t("reg.form.out")} ${fmtTime(row.requested_last_out_at)}`);
  if (row.requested_status !== null && row.requested_status.length > 0) {
    parts.push(row.requested_status === "on_duty" ? t("reg.type.on_duty") : t("reg.type.work_from_home"));
  }
  return parts.length > 0 ? parts.join(" · ") : dash(null);
}

const OPEN_STATUSES = new Set(["draft", "pending"]);

export default function MyRegularizationsPage() {
  const today = nowIstDate();
  const list = useMyRegularizations();
  const quota = useRegularizationQuota(today);
  const withdraw = useWithdrawRegularization();
  const [busyId, setBusyId] = useState<string | null>(null);

  function onWithdraw(row: Regularization) {
    setBusyId(row.id);
    withdraw.mutate(row.id, {
      onSuccess: () => toast.success(t("reg.withdraw.done")),
      onError: () => toast.error(t("reg.withdraw.failed")),
      onSettled: () => setBusyId(null),
    });
  }

  const columns: DataGridColumn<Regularization>[] = [
    {
      key: "ist_date",
      header: t("reg.col.date"),
      width: "8.5rem",
      sortable: true,
      render: (row) => fmtCivilDate(row.ist_date),
    },
    {
      key: "regularization_kind",
      header: t("reg.col.type"),
      render: (row) => kindLabel(row.regularization_kind),
    },
    {
      key: "requested",
      header: t("reg.col.change"),
      hideBelow: "md",
      render: requestedChange,
    },
    {
      key: "status",
      header: t("reg.col.status"),
      width: "11rem",
      render: (row) => <StatusChip status={row.status} map={STATUS_MAP} />,
    },
    {
      key: "with",
      header: t("reg.col.with"),
      hideBelow: "lg",
      render: (row) => (OPEN_STATUSES.has(row.status) ? t("reg.with.manager") : t("reg.with.decided")),
    },
    {
      key: "created_at",
      header: t("reg.col.submitted"),
      hideBelow: "lg",
      render: (row) => fmtDateTime(row.created_at),
    },
    {
      key: "decided_at",
      header: t("reg.col.decided"),
      hideBelow: "lg",
      render: (row) => dash(row.decided_at, fmtDateTime),
    },
    {
      key: "ref",
      header: t("reg.col.ref"),
      hideBelow: "lg",
      render: (row) => <span className="font-mono text-xs">{regularizationRef(row)}</span>,
    },
    {
      key: "action",
      header: t("reg.col.action"),
      align: "right",
      width: "8rem",
      render: (row) =>
        OPEN_STATUSES.has(row.status) ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busyId === row.id}
            onClick={() => onWithdraw(row)}
          >
            {t("reg.action.withdraw")}
          </Button>
        ) : (
          dash(null)
        ),
    },
  ];

  const cap = quota.data?.cap ?? null;
  const used = quota.data?.used ?? 0;
  const monthLabel = fmtMonth(`${quota.data?.month ?? today.slice(0, 7)}-01T00:00:00+05:30`);
  const blocked = cap !== null && used >= cap;
  const amber = cap !== null && !blocked && used >= cap - 1;

  return (
    <div className="container py-6">
      <PageHeader
        icon={ClipboardList}
        title={t("reg.list.title")}
        subtitle={t("reg.list.subtitle")}
        actions={
          blocked ? (
            <Button disabled title={t("reg.quota.blocked", { cap: cap ?? 0, month: monthLabel })}>
              <Plus className="mr-1.5 h-4 w-4" aria-hidden />
              {t("reg.list.new")}
            </Button>
          ) : (
            <Button asChild>
              <Link to="/me/regularizations/new">
                <Plus className="mr-1.5 h-4 w-4" aria-hidden />
                {t("reg.list.new")}
              </Link>
            </Button>
          )
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <KpiTile
          label={t("reg.quota.title")}
          value={cap === null ? String(used) : `${used} / ${cap}`}
          tone={blocked ? "danger" : amber ? "warn" : "neutral"}
          hint={
            cap === null
              ? t("reg.form.serverRules")
              : blocked
                ? t("reg.quota.blocked", { cap, month: monthLabel })
                : amber
                  ? t("reg.quota.amber", { month: monthLabel })
                  : t("reg.quota.used", { used, cap, month: monthLabel })
          }
          explainer={{
            formula: t("reg.quota.formula"),
            numbers: t("reg.quota.numbers", {
              used,
              month: monthLabel,
              cap: cap === null ? "—" : cap,
            }),
          }}
        />
      </div>

      <StateBoundary
        loading={list.isLoading}
        error={list.error ?? undefined}
        onRetry={() => void list.refetch()}
        isEmpty={list.data !== undefined && list.data.length === 0}
        partialError={quota.error ?? undefined}
        partialLabel={t("reg.quota.title")}
        empty={
          <EmptyState
            icon={ClipboardList}
            title={t("reg.empty.title")}
            hint={t("reg.empty.hint")}
            action={
              <Button asChild>
                <Link to="/me/regularizations/new">{t("reg.list.new")}</Link>
              </Button>
            }
          />
        }
      >
        <DataGrid
          columns={columns}
          rows={list.data ?? []}
          rowKey={(row) => row.id}
          pageSize={25}
        />
      </StateBoundary>
    </div>
  );
}
