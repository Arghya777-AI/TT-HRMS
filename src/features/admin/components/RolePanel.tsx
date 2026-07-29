/**
 * RolePanel — set who is an admin, a manager or a normal user.
 *
 * Mounted on the People directory, because "what can this person see" is a question
 * about a person and HR is already looking at people when they ask it.
 *
 * THE MISMATCH COLUMN IS THE POINT OF THE SCREEN. Two states can be wrong and neither
 * is visible anywhere else:
 *
 *   · `team_without_manager_role` — somebody has reportees and no manager role. This
 *     is what hid three teams in this deployment, and the symptom was a manager being
 *     told "as an employee your access is limited to your own records".
 *   · `manager_without_team` — a leftover manager grant after a reorganisation.
 *
 * They are REPORTED, not auto-corrected. A role is somebody's access and it should not
 * change silently because a reportee moved department.
 *
 * NOTHING IS DISABLED ON A GUESS beyond the two things the screen can know for
 * certain: an employee with no login has no role to set, and `can_manage` is the
 * server's own answer. Everything else — scope, super-admin, the self-demotion rule,
 * the manager rule — is left to the server, whose refusals are shown verbatim because
 * they explain themselves better than a greyed-out button can.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, TriangleAlert, Users } from "lucide-react";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { shouldRetryQuery } from "@/shared/api/query";
import { asArray } from "@/lib/asArray";
import { formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { PersonCell } from "./PersonCell";
import { SelectField } from "./Field";
import {
  assignableRoles,
  fetchEmployeeRoles,
  setEmployeeRole,
  type AssignableRole,
  type EffectiveRole,
  type EmployeeRoleRow,
} from "../api/roles.api";

const KEY = ["admin", "employee-roles"] as const;

const ROLE_CHIP: Readonly<Record<EffectiveRole, StatusChipEntry>> = {
  employee: { label: t("admin.roles.role.employee"), tone: "neutral" },
  manager: { label: t("admin.roles.role.manager"), tone: "info" },
  // HR and admin are the same role here, which is what was asked for.
  admin: { label: t("admin.roles.role.admin"), tone: "success" },
  super_admin: { label: t("admin.roles.role.superAdmin"), tone: "warn" },
  no_login: { label: t("admin.roles.role.noLogin"), tone: "neutral" },
};

function RoleCell({ row }: { row: EmployeeRoleRow }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  // The reason travels WITH the mutation, not through a module-level or window
  // variable: two rows changed in quick succession would otherwise race and one
  // would be audited with the other's reason.
  const change = useMutation({
    mutationFn: (v: { role: AssignableRole; reason: string }) =>
      setEmployeeRole(row.employee_id, v.role, v.reason),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  if (!row.can_manage) {
    return <span className="text-xs text-muted-foreground">{t("admin.roles.adminOnly")}</span>;
  }
  if (row.profile_id === null) {
    // Not a refusal to be discovered after clicking: there is genuinely no account.
    return <span className="text-xs text-muted-foreground">{t("admin.roles.noAccount")}</span>;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <SelectField
        label=""
        value={row.effective_role === "no_login" ? "" : row.effective_role}
        options={assignableRoles.map((r) => ({ value: r, label: ROLE_CHIP[r].label }))}
        disabled={change.isPending}
        onChange={(v) => {
          if (v === "" || v === row.effective_role) return;
          // A prompt, not a silent write: the server wants ten characters and this
          // sentence is what the audit row carries months from now.
          const reason = window.prompt(t("admin.roles.reasonPrompt", { name: row.display_name ?? "" }));
          if (reason === null || reason.trim().length < 10) return;
          change.mutate({ role: v as AssignableRole, reason: reason.trim() });
        }}
      />
      {error !== null ? (
        <span className="max-w-[20rem] text-right text-xs text-destructive">{error}</span>
      ) : null}
    </div>
  );
}

export function RolePanel() {
  const roles = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => fetchEmployeeRoles(signal),
    retry: shouldRetryQuery,
  });
  const rows = asArray(roles.data);
  const mismatches = rows.filter((r) => r.manager_without_team || r.team_without_manager_role);

  const columns: DataGridColumn<EmployeeRoleRow>[] = [
    {
      key: "display_name",
      header: t("admin.roles.col.person"),
      width: "16rem",
      render: (row) => <PersonCell name={row.display_name ?? "—"} code={row.employee_code ?? ""} />,
    },
    {
      key: "effective_role",
      header: t("admin.roles.col.access"),
      width: "10rem",
      render: (row) => <StatusChip status={row.effective_role} map={ROLE_CHIP} />,
    },
    {
      key: "reportee_count",
      header: t("admin.roles.col.reportees"),
      width: "9rem",
      align: "right",
      hideBelow: "md",
      render: (row) => <span className="num text-sm">{formatNumber(row.reportee_count)}</span>,
    },
    {
      key: "mismatch",
      header: t("admin.roles.col.check"),
      width: "17rem",
      hideBelow: "lg",
      /* The whole reason this screen exists. Named in full rather than as a warning
         icon, because the fix is different for each and the reader has to know which. */
      render: (row) =>
        row.team_without_manager_role ? (
          <span className="inline-flex items-start gap-1.5 text-xs text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {t("admin.roles.check.teamNoRole")}
          </span>
        ) : row.manager_without_team ? (
          <span className="inline-flex items-start gap-1.5 text-xs text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {t("admin.roles.check.managerNoTeam")}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">{t("admin.roles.check.ok")}</span>
        ),
    },
    {
      key: "set",
      header: t("admin.roles.col.set"),
      align: "right",
      width: "16rem",
      render: (row) => <RoleCell row={row} />,
    },
  ];

  return (
    <section className="mt-8">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
        <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
        {t("admin.roles.title")}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {mismatches.length > 0
          ? t("admin.roles.subtitle.mismatch", { n: formatNumber(mismatches.length) })
          : t("admin.roles.subtitle.ok")}
      </p>

      <div className="mt-3">
        <StateBoundary
          loading={roles.isPending}
          error={roles.error}
          onRetry={() => void roles.refetch()}
          isEmpty={!roles.isPending && roles.error === null && rows.length === 0}
          empty={<EmptyState icon={Users} title={t("admin.roles.empty")} />}
          skeletonRows={5}
        >
          <DataGrid columns={columns} rows={rows} rowKey={(r) => r.employee_id} pageSize={15} />
        </StateBoundary>
      </div>
    </section>
  );
}
