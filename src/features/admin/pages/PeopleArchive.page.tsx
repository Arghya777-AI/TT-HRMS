/**
 * A-PPL-08 · /admin/people/archive — "Soft-deleted records, restorable with a
 * reason" (route manifest), spec-admin §1.4.
 *
 * THE READ PATH IS THE BASE TABLE, DELIBERATELY. Every other admin employee
 * screen reads `v_admin_employee`, and this one must not: that view ends in
 * `WHERE e.deleted_at IS NULL` (migration 033 §5), so a `deleted_at IS NOT NULL`
 * filter against it returns zero rows forever. The failure would be invisible —
 * an empty grid reading "nothing has ever been archived" instead of "this screen
 * cannot see archived rows". So the archive reads `public.employees`, which
 * migration 051 §1 made admin-visible for exactly this console ("soft-deletes
 * visible to admins on purpose — the Archive console needs them"), with
 * table-wide SELECT from §2. The price is honest: no resolved department or
 * designation names, because the base table has no such columns and this screen
 * will not invent a join the database did not perform.
 *
 * THERE IS NO `archived` COLUMN. `deleted_at IS NOT NULL` is the archive
 * predicate, and `ck_employees__deletion_reason` guarantees an archived row
 * always carries both an actor and a reason of at least ten characters — so the
 * "why was this person removed" column is never empty by construction.
 *
 * RESTORE is `restoreRow` from the sanctioned query layer: an UPDATE clearing
 * `deleted_at`/`deleted_by` and writing the freshly typed sentence into
 * `deletion_reason`. It is never a DELETE and never an INSERT. The audit trigger
 * classifies it as `action = 'restore'` on its own, because `deleted_at` goes
 * value → NULL. Both counts on this page are `count=exact` HEAD requests, so the
 * total never depends on the row cap.
 *
 * NOT AVAILABLE, and therefore not offered: there is no hard-delete path from a
 * browser (`employee.hard_delete` is a super-admin capability with no client
 * write path), and no purge/DPDP-erasure endpoint is deployed, so this screen
 * restores or it does nothing.
 *
 * @route /admin/people/archive
 */
import { useMemo, useState } from "react";
import { ArchiveRestore, Users } from "lucide-react";
import { toast } from "sonner";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { useAuth } from "@/app/auth/AuthProvider";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { ReasonActionButton } from "../components/ReasonActionButton";
import { TextField } from "../components/Field";
import { EMPLOYMENT_STATUS_LABELS } from "../api/employees.api";
import type { ArchivedEmployee } from "../api/settings-extra.api";
import {
  useArchivedEmployeeCount,
  useArchivedEmployees,
  useEmployeeRestoreMutation,
  useProfileDirectory,
} from "../hooks/useSettingsExtra";

/** The server caps this read; the screen says so rather than pretending. */
const ROW_CAP = 200;

/**
 * Enum → sentence, built as a Map so a value outside the deployed enum degrades
 * to `—` instead of leaking a raw identifier onto the screen (D-10).
 */
const STATUS_LABEL = new Map<string, string>(Object.entries(EMPLOYMENT_STATUS_LABELS));

const EXIT_TYPE_LABEL = new Map<string, string>([
  ["resignation", t("admin.archive.exitType.resignation")],
  ["termination", t("admin.archive.exitType.termination")],
  ["end_of_contract", t("admin.archive.exitType.endOfContract")],
  ["retirement", t("admin.archive.exitType.retirement")],
  ["absconding", t("admin.archive.exitType.absconding")],
  ["death", t("admin.archive.exitType.death")],
]);

function countFace(q: { data: number | undefined; error: Error | null; isPending: boolean }): string {
  if (q.isPending) return t("app.loading");
  if (q.error !== null) return dash(null);
  return dash(q.data ?? null, formatNumber);
}

export default function PeopleArchivePage() {
  const { can } = useAuth();
  const isAdmin = can("admin.access");

  const [nameLike, setNameLike] = useState("");
  const [employeeCode, setEmployeeCode] = useState("");

  /** Only non-empty filters reach the query key, so "" and undefined agree. */
  const filters = useMemo(
    () => ({
      ...(nameLike.trim() !== "" ? { nameLike: nameLike.trim() } : {}),
      ...(employeeCode.trim() !== "" ? { employeeCode: employeeCode.trim() } : {}),
    }),
    [nameLike, employeeCode],
  );

  const hasFilter = Object.keys(filters).length > 0;

  const rows = useArchivedEmployees(filters);
  const matching = useArchivedEmployeeCount(filters);
  const archivedTotal = useArchivedEmployeeCount({});
  const profiles = useProfileDirectory();
  const restore = useEmployeeRestoreMutation();

  /** profile id → who archived the row. `deleted_by` REFERENCES profiles(id). */
  const profileNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of profiles.data ?? []) map.set(p.id, p.full_name);
    return map;
  }, [profiles.data]);

  const list = rows.data ?? [];
  const capped = matching.data !== undefined && matching.data > ROW_CAP;

  const columns: DataGridColumn<ArchivedEmployee>[] = [
    {
      key: "display_name",
      header: t("admin.archive.col.person"),
      width: "16rem",
      sortable: true,
      sortValue: (row) => row.display_name,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="text-sm font-medium">{row.display_name}</span>
          <span className="num text-xs text-muted-foreground">{row.employee_code}</span>
        </span>
      ),
    },
    {
      key: "employment_status",
      header: t("admin.archive.col.status"),
      width: "9rem",
      render: (row) => (
        <span className="text-sm">{STATUS_LABEL.get(row.employment_status) ?? dash(null)}</span>
      ),
    },
    {
      key: "date_of_join",
      header: t("admin.archive.col.joined"),
      align: "right",
      width: "10rem",
      hideBelow: "md",
      render: (row) => <span className="num">{fmtCivilDate(row.date_of_join)}</span>,
    },
    {
      key: "last_working_day",
      header: t("admin.archive.col.lastDay"),
      align: "right",
      width: "10rem",
      hideBelow: "lg",
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="num">{fmtCivilDate(row.last_working_day)}</span>
          {row.exit_type !== null ? (
            <span className="text-xs text-muted-foreground">
              {EXIT_TYPE_LABEL.get(row.exit_type) ?? dash(null)}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "deleted_at",
      header: t("admin.archive.col.archived"),
      width: "13rem",
      sortable: true,
      sortValue: (row) => row.deleted_at,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="num text-sm">{fmtDateTime(row.deleted_at)}</span>
          <span className="text-xs text-muted-foreground">
            {t("admin.archive.by", {
              name:
                row.deleted_by === null
                  ? t("admin.archive.unknownActor")
                  : (profileNames.get(row.deleted_by) ?? t("admin.archive.unknownActor")),
            })}
          </span>
        </span>
      ),
    },
    {
      key: "deletion_reason",
      header: t("admin.archive.col.reason"),
      hideBelow: "lg",
      render: (row) => <span className="text-xs">{dash(row.deletion_reason)}</span>,
    },
    {
      key: "actions",
      header: t("admin.archive.col.actions"),
      align: "right",
      width: "10rem",
      render: (row) => {
        if (!isAdmin) {
          return (
            <span className="text-xs text-muted-foreground">{t("admin.archive.readOnly")}</span>
          );
        }
        return (
          <ReasonActionButton
            label={t("admin.archive.action.restore")}
            variant="default"
            minLength={restore.minReasonLength}
            title={t("admin.archive.restore.title", { name: row.display_name })}
            description={t("admin.archive.restore.description", {
              name: row.display_name,
              code: row.employee_code,
              when: fmtDateTime(row.deleted_at),
            })}
            onConfirm={async (reason) => {
              await restore.saveAsync({ employeeId: row.id }, reason);
              toast.success(t("admin.archive.restored", { name: row.display_name }));
            }}
          />
        );
      },
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={ArchiveRestore}
        title={t("admin.archive.title")}
        subtitle={t("admin.archive.subtitle")}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <KpiTile
          label={t("admin.archive.kpi.total")}
          value={countFace(archivedTotal)}
          hint={t("admin.archive.kpi.totalHint")}
        />
        <KpiTile
          label={t("admin.archive.kpi.matching")}
          value={countFace(matching)}
          hint={
            hasFilter ? t("admin.archive.kpi.matchingHint") : t("admin.archive.kpi.matchingAllHint")
          }
        />
      </div>

      <section className="mt-6 rounded-lg border bg-card p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <TextField
            label={t("admin.archive.filter.name")}
            value={nameLike}
            onChange={setNameLike}
            placeholder={t("admin.archive.filter.namePlaceholder")}
            hint={t("admin.archive.filter.nameHint")}
          />
          <TextField
            label={t("admin.archive.filter.code")}
            value={employeeCode}
            onChange={setEmployeeCode}
            placeholder={t("admin.archive.filter.codePlaceholder")}
            hint={t("admin.archive.filter.codeHint")}
          />
        </div>
      </section>

      <Notice tone="info" className="mt-4">
        {t("admin.archive.notice.readPath")}
      </Notice>

      {capped ? (
        <Notice tone="warning" className="mt-3">
          {t("admin.archive.notice.capped", { cap: formatNumber(ROW_CAP) })}
        </Notice>
      ) : null}

      {restore.userMessage !== null ? (
        <Notice tone="error" className="mt-3">
          {restore.userMessage}
        </Notice>
      ) : null}

      <section className="mt-6">
        <StateBoundary
          loading={rows.isPending}
          error={rows.error}
          onRetry={() => void rows.refetch()}
          isEmpty={rows.isSuccess && list.length === 0}
          partialError={profiles.error}
          partialLabel={t("admin.archive.partial.names")}
          empty={
            <EmptyState
              icon={Users}
              title={
                hasFilter
                  ? t("admin.archive.empty.filtered.title")
                  : t("admin.archive.empty.title")
              }
              hint={hasFilter ? t("admin.archive.empty.filtered.hint") : t("admin.archive.empty.hint")}
            />
          }
          skeletonRows={5}
        >
          <DataGrid columns={columns} rows={list} rowKey={(row) => row.id} pageSize={25} />
        </StateBoundary>
      </section>

      <p className="mt-6 text-xs text-muted-foreground">{t("admin.archive.footnote")}</p>
    </div>
  );
}
