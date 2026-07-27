/**
 * A-SET-02 · /admin/settings/roles — "Who can do what, with an audit of every
 * grant" (spec-admin §15.2, route manifest).
 *
 * Three separate truths live on this screen, and keeping them apart is the whole
 * design:
 *
 *  1. WHAT A ROLE MAY DO — `role_capabilities` (migration 050 §2), the table
 *     `app.has_cap()` resolves on every request. It is readable by any
 *     authenticated user and writable only by a super admin, and this screen
 *     does NOT offer to edit it: §15.2's matrix editor carries a "hard-coded
 *     super_admin floor" (role grants, hard delete, audit export, retention
 *     purge, biometric purge, period unlock, payroll reopen, security settings,
 *     API keys, metric definitions) which no deployed constraint enforces yet.
 *     A matrix editor that let an admin be given `employee.hard_delete` would be
 *     worse than a read-only matrix, so the matrix is read-only and says why.
 *  2. WHO HOLDS A ROLE — `user_roles`, super-admin INSERT/UPDATE only and
 *     reason-required. A revoke is an UPDATE stamping `revoked_at`, never a
 *     DELETE: the grant history is the evidence an auditor came for.
 *  3. WHAT THEY CAN SEE WITH IT — `employee_role_assignments`. This is the row
 *     DEMO-ACCOUNTS.md warns about: an `admin` grant with no assignment row
 *     opens every admin screen and lists ZERO employees, because every admin
 *     read passes through `app.admin_scope_covers()`. A Roles screen that hides
 *     the scope register is lying about what a grant does.
 *
 * `super_admin` is deliberately NOT grantable here. §16.1 forbids granting it
 * casually and §16.2 wants four-eyes; the four-eyes ledger
 * (`pending_second_approval` + a named second approver) is not deployed, so the
 * quiet single-click path is not offered at all.
 *
 * Step-up: `role.grant` and `role.revoke` both carry
 * `role_capabilities.requires_step_up = true`, so both actions ask for the
 * authenticator code through `useStepUp` before the write, and retry once if the
 * server itself answers `MFA_STEP_UP_REQUIRED`. Note the honest limit — the
 * DIRECT table path is guarded by `app.is_super_admin()` only; there is no aal2
 * predicate in `user_roles__super_admin_insert`, so this ceremony is the client's
 * discipline, not a database boundary.
 *
 * @route /admin/settings/roles
 */
import { useMemo, useState } from "react";
import { Check, Minus, ShieldCheck, Users } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { isStepUpRequired, useStepUp } from "@/shared/auth/StepUpDialog";
import { useAuth } from "@/app/auth/AuthProvider";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { ReasonActionButton } from "../components/ReasonActionButton";
import { SelectField } from "../components/Field";
import type { AppRole, RoleAssignment, UserRole } from "../api/system.api";
import { GRANTABLE_ROLES } from "../api/settings-extra.api";
import {
  capRequiresStepUp,
  useCapabilityCount,
  useProfileDirectory,
  useRoleAssignments,
  useRoleCapabilities,
  useRoleGrantCount,
  useRoleGrantMutation,
  useRoleGrants,
  useRoleRevokeMutation,
} from "../hooks/useSettingsExtra";

const ROLE_ORDER: readonly AppRole[] = ["employee", "manager", "admin", "super_admin"];

const ROLE_LABEL: Readonly<Record<AppRole, string>> = {
  employee: t("admin.roles.role.employee"),
  manager: t("admin.roles.role.manager"),
  admin: t("admin.roles.role.admin"),
  super_admin: t("admin.roles.role.superAdmin"),
};

const ROLE_CHIP: Readonly<Record<AppRole, StatusChipEntry>> = {
  employee: { label: ROLE_LABEL.employee, tone: "neutral" },
  manager: { label: ROLE_LABEL.manager, tone: "info" },
  admin: { label: ROLE_LABEL.admin, tone: "warn" },
  super_admin: { label: ROLE_LABEL.super_admin, tone: "danger" },
};

/**
 * The four roles, explained for the client rather than for an engineer.
 *
 * HR is `admin`: `public.app_role` is exactly
 * ('employee','manager','admin','super_admin') (migration 003) and
 * `public.resolve_approver_kind('hr_admin', …)` (migration 029) resolves the HR
 * approver set as `user_roles.role = 'admin'`. `app.has_role()` nests the roles,
 * so an admin holds every employee, manager and admin row of the matrix below.
 */
const ROLE_PLAIN_ENGLISH: readonly { role: AppRole; body: string }[] = [
  { role: "employee", body: t("roles.legend.employeeBody") },
  { role: "manager", body: t("roles.legend.managerBody") },
  { role: "admin", body: t("roles.legend.adminBody") },
  { role: "super_admin", body: t("roles.legend.superAdminBody") },
];

const GRANT_STATE_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  live: { label: t("admin.roles.grant.live"), tone: "success" },
  revoked: { label: t("admin.roles.grant.revoked"), tone: "neutral" },
};

/** One row of the capability matrix: a capability and the roles that hold it. */
interface MatrixRow {
  readonly capability: string;
  readonly description: string | null;
  readonly roles: readonly AppRole[];
  readonly requiresStepUp: boolean;
}

interface GrantRow {
  readonly grant: UserRole;
  readonly holder: string;
  readonly holderEmail: string | null;
  readonly grantedBy: string;
}

/** A count tile's face: the server's number, `—` when it could not be read. */
function countFace(q: { data: number | undefined; error: Error | null; isPending: boolean }): string {
  if (q.isPending) return t("app.loading");
  if (q.error !== null) return dash(null);
  return dash(q.data ?? null, formatNumber);
}

export default function RolesPage() {
  const { can, user } = useAuth();
  const isSuper = can("admin.super");
  const actorId = user?.id ?? null;

  const capabilities = useRoleCapabilities();
  const grants = useRoleGrants();
  const assignments = useRoleAssignments();
  const profiles = useProfileDirectory();

  const liveGrants = useRoleGrantCount();
  const superAdmins = useRoleGrantCount("super_admin");
  const admins = useRoleGrantCount("admin");
  const capabilityCount = useCapabilityCount();

  const grant = useRoleGrantMutation();
  const revoke = useRoleRevokeMutation();
  const stepUp = useStepUp();

  const [pickedUserId, setPickedUserId] = useState("");
  const [pickedRole, setPickedRole] = useState<AppRole>("admin");

  const grantNeedsStepUp = capRequiresStepUp(capabilities.data, "role.grant");
  const revokeNeedsStepUp = capRequiresStepUp(capabilities.data, "role.revoke");

  /** profile id → label, for the grant register and the scope register. */
  const profileNames = useMemo(() => {
    const map = new Map<string, { name: string; email: string }>();
    for (const p of profiles.data ?? []) map.set(p.id, { name: p.full_name, email: p.email });
    return map;
  }, [profiles.data]);

  const matrixRows = useMemo<MatrixRow[]>(() => {
    const byCapability = new Map<
      string,
      { description: string | null; roles: AppRole[]; requiresStepUp: boolean }
    >();
    for (const row of capabilities.data ?? []) {
      const existing = byCapability.get(row.capability);
      if (existing === undefined) {
        byCapability.set(row.capability, {
          description: row.description,
          roles: [row.role],
          requiresStepUp: row.requires_step_up,
        });
        continue;
      }
      existing.roles.push(row.role);
      if (existing.description === null) existing.description = row.description;
      if (row.requires_step_up) existing.requiresStepUp = true;
    }
    return [...byCapability.entries()]
      .map(([capability, v]) => ({
        capability,
        description: v.description,
        roles: v.roles,
        requiresStepUp: v.requiresStepUp,
      }))
      .sort((a, b) => a.capability.localeCompare(b.capability));
  }, [capabilities.data]);

  const grantRows = useMemo<GrantRow[]>(
    () =>
      (grants.data ?? []).map((g) => {
        const holder = profileNames.get(g.user_id);
        const granter = g.granted_by === null ? undefined : profileNames.get(g.granted_by);
        return {
          grant: g,
          holder: holder?.name ?? t("admin.roles.unknownHolder"),
          holderEmail: holder?.email ?? null,
          grantedBy: granter?.name ?? t("admin.roles.systemGranter"),
        };
      }),
    [grants.data, profileNames],
  );

  const grantOptions = useMemo(
    () =>
      (profiles.data ?? []).map((p) => ({
        value: p.id,
        label: p.is_active
          ? t("admin.roles.picker.option", { name: p.full_name, email: p.email })
          : t("admin.roles.picker.optionInactive", { name: p.full_name, email: p.email }),
      })),
    [profiles.data],
  );

  /** Ask for the second factor when the matrix says the capability needs one. */
  async function withStepUp(needed: boolean, write: () => Promise<unknown>): Promise<boolean> {
    if (needed) {
      const upgraded = await stepUp.ensureAal2();
      if (!upgraded) return false;
    }
    try {
      await write();
      return true;
    } catch (error) {
      if (!isStepUpRequired(error)) throw error;
      const upgraded = await stepUp.ensureAal2();
      if (!upgraded) return false;
      await write();
      return true;
    }
  }

  const roleColumns: DataGridColumn<MatrixRow>[] = ROLE_ORDER.map((role) => ({
    key: role,
    header: ROLE_LABEL[role],
    align: "center" as const,
    width: "8rem",
    render: (row: MatrixRow) =>
      row.roles.includes(role) ? (
        <span className="inline-flex items-center justify-center text-success">
          <Check className="h-4 w-4" aria-hidden />
          <span className="sr-only">{t("admin.roles.matrix.held")}</span>
        </span>
      ) : (
        <span className="inline-flex items-center justify-center text-muted-foreground">
          <Minus className="h-4 w-4" aria-hidden />
          <span className="sr-only">{t("admin.roles.matrix.notHeld")}</span>
        </span>
      ),
  }));

  const matrixColumns: DataGridColumn<MatrixRow>[] = [
    {
      key: "capability",
      header: t("admin.roles.matrix.col.capability"),
      sortable: true,
      sortValue: (row) => row.capability,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="font-mono text-xs">{row.capability}</span>
          {row.description !== null ? (
            <span className="mt-0.5 max-w-md text-xs text-muted-foreground">
              {row.description}
            </span>
          ) : null}
        </span>
      ),
    },
    ...roleColumns,
    {
      key: "requiresStepUp",
      header: t("admin.roles.matrix.col.stepUp"),
      align: "center",
      width: "9rem",
      hideBelow: "md",
      render: (row) =>
        row.requiresStepUp ? (
          <Badge variant="warning">{t("admin.roles.matrix.stepUpYes")}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">{t("admin.roles.matrix.stepUpNo")}</span>
        ),
    },
  ];

  const grantColumns: DataGridColumn<GrantRow>[] = [
      {
        key: "holder",
        header: t("admin.roles.grants.col.holder"),
        width: "16rem",
        sortable: true,
        sortValue: (row) => row.holder,
        render: (row) => (
          <span className="flex flex-col leading-tight">
            <span className="text-sm font-medium">{row.holder}</span>
            <span className="text-xs text-muted-foreground">{dash(row.holderEmail)}</span>
          </span>
        ),
      },
      {
        key: "role",
        header: t("admin.roles.grants.col.role"),
        width: "9rem",
        render: (row) => <StatusChip status={row.grant.role} map={ROLE_CHIP} />,
      },
      {
        key: "state",
        header: t("admin.roles.grants.col.state"),
        width: "8rem",
        render: (row) => (
          <StatusChip
            status={row.grant.revoked_at === null ? "live" : "revoked"}
            map={GRANT_STATE_CHIP}
          />
        ),
      },
      {
        key: "granted_at",
        header: t("admin.roles.grants.col.granted"),
        width: "13rem",
        sortable: true,
        sortValue: (row) => row.grant.granted_at,
        render: (row) => (
          <span className="flex flex-col leading-tight">
            <span className="num text-sm">{fmtDateTime(row.grant.granted_at)}</span>
            <span className="text-xs text-muted-foreground">
              {t("admin.roles.grants.by", { name: row.grantedBy })}
            </span>
          </span>
        ),
      },
      {
        key: "granted_reason",
        header: t("admin.roles.grants.col.reason"),
        hideBelow: "lg",
        render: (row) => (
          <span className="flex flex-col gap-1 leading-tight">
            <span className="text-xs">{dash(row.grant.granted_reason)}</span>
            {row.grant.revoked_at !== null ? (
              <span className="text-xs text-muted-foreground">
                {t("admin.roles.grants.revokedOn", {
                  when: fmtDateTime(row.grant.revoked_at),
                  reason: dash(row.grant.revoke_reason),
                })}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        key: "actions",
        header: t("admin.roles.grants.col.actions"),
        align: "right",
        width: "11rem",
        render: (row) => {
          if (row.grant.revoked_at !== null) {
            return <span className="text-xs text-muted-foreground">{t("admin.roles.grants.closed")}</span>;
          }
          if (!isSuper || actorId === null) {
            return <span className="text-xs text-muted-foreground">{t("admin.console.superOnly")}</span>;
          }
          return (
            <ReasonActionButton
              label={t("admin.roles.action.revoke")}
              variant="destructive"
              minLength={revoke.minReasonLength}
              title={t("admin.roles.revoke.title", {
                role: ROLE_LABEL[row.grant.role],
                name: row.holder,
              })}
              description={t("admin.roles.revoke.description", { name: row.holder })}
              onConfirm={async (reason) => {
                const done = await withStepUp(revokeNeedsStepUp, () =>
                  revoke.saveAsync({ grantId: row.grant.id, revokedBy: actorId }, reason),
                );
                if (done) toast.success(t("admin.roles.revoked", { name: row.holder }));
              }}
            />
          );
        },
      },
  ];

  const assignmentColumns: DataGridColumn<RoleAssignment>[] = [
      {
        key: "profile_id",
        header: t("admin.roles.scope.col.holder"),
        width: "16rem",
        render: (row) => (
          <span className="text-sm">
            {profileNames.get(row.profile_id)?.name ?? t("admin.roles.unknownHolder")}
          </span>
        ),
      },
      {
        key: "role",
        header: t("admin.roles.scope.col.role"),
        width: "9rem",
        render: (row) => <StatusChip status={row.role} map={ROLE_CHIP} />,
      },
      {
        key: "scope_kind",
        header: t("admin.roles.scope.col.kind"),
        render: (row) => <span className="font-mono text-xs">{row.scope_kind}</span>,
      },
      {
        key: "effective_from",
        header: t("admin.roles.scope.col.from"),
        align: "right",
        width: "10rem",
        render: (row) => <span className="num">{fmtCivilDate(row.effective_from)}</span>,
      },
      {
        key: "effective_to",
        header: t("admin.roles.scope.col.to"),
        align: "right",
        width: "10rem",
        hideBelow: "md",
        render: (row) => (
          <span className="num">
            {row.effective_to === null
              ? t("admin.roles.scope.openEnded")
              : fmtCivilDate(row.effective_to)}
          </span>
        ),
      },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={ShieldCheck}
        title={t("admin.roles.title")}
        subtitle={t("admin.roles.subtitle")}
      />

      {/* ── HR == admin, said in words a client reads once and remembers ───── */}
      <section className="mb-6 rounded-lg border border-info/40 bg-info/5 p-5">
        <h2 className="flex items-center gap-2 font-display text-base font-semibold">
          <ShieldCheck className="h-4 w-4 text-info" aria-hidden />
          {t("roles.hrIsAdmin.title")}
        </h2>
        <p className="mt-2 max-w-4xl text-sm text-foreground">{t("roles.hrIsAdmin.body")}</p>

        <h3 className="mt-4 text-sm font-semibold">{t("roles.superReserved.title")}</h3>
        <p className="mt-1 max-w-4xl text-sm text-muted-foreground">
          {t("roles.superReserved.body")}
        </p>

        <h3 className="mt-4 text-sm font-semibold">{t("roles.legend.title")}</h3>
        <dl className="mt-2 grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {ROLE_PLAIN_ENGLISH.map(({ role, body }) => (
            <div key={role} className="min-w-0">
              <dt className="mb-1">
                <StatusChip status={role} map={ROLE_CHIP} />
              </dt>
              <dd className="text-sm text-muted-foreground">{body}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 max-w-4xl text-xs text-muted-foreground">
          {t("roles.legend.scopeNote")}
        </p>
      </section>

      {!isSuper ? (
        <Notice tone="info" className="mb-6">
          {t("roles.readOnlyForAdmin")}
        </Notice>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label={t("admin.roles.kpi.live")}
          value={countFace(liveGrants)}
          hint={t("admin.roles.kpi.liveHint")}
        />
        <KpiTile
          label={t("admin.roles.kpi.superAdmins")}
          value={countFace(superAdmins)}
          hint={t("admin.roles.kpi.superAdminsHint")}
          tone={
            superAdmins.data !== undefined && superAdmins.data < 2 ? "warn" : "neutral"
          }
        />
        <KpiTile
          label={t("admin.roles.kpi.admins")}
          value={countFace(admins)}
          hint={t("admin.roles.kpi.adminsHint")}
        />
        <KpiTile
          label={t("admin.roles.kpi.capabilities")}
          value={countFace(capabilityCount)}
          hint={t("admin.roles.kpi.capabilitiesHint")}
        />
      </div>

      {superAdmins.isSuccess && superAdmins.data < 2 ? (
        <Notice tone="warning" className="mt-4">
          {t("admin.roles.notice.singleSuperAdmin")}
        </Notice>
      ) : null}

      {/* ── Grant a role ─────────────────────────────────────────────────── */}
      <section className="mt-6 rounded-lg border bg-card">
        <h2 className="border-b px-4 py-3 font-display text-base font-semibold">
          {t("admin.roles.grantForm.title")}
        </h2>
        <div className="p-4">
          {!isSuper ? (
            <Notice tone="info">{t("admin.roles.grantForm.superOnly")}</Notice>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <SelectField
                  label={t("admin.roles.grantForm.person")}
                  value={pickedUserId}
                  placeholder={t("admin.roles.grantForm.personPlaceholder")}
                  options={grantOptions}
                  onChange={setPickedUserId}
                  hint={t("admin.roles.grantForm.personHint")}
                />
                <SelectField
                  label={t("admin.roles.grantForm.role")}
                  value={pickedRole}
                  options={GRANTABLE_ROLES.map((role) => ({
                    value: role,
                    label: ROLE_LABEL[role],
                  }))}
                  onChange={(v) => setPickedRole(v as AppRole)}
                  hint={t("admin.roles.grantForm.roleHint")}
                />
                <div className="flex items-end">
                  <ReasonActionButton
                    label={t("admin.roles.action.grant")}
                    variant="default"
                    minLength={grant.minReasonLength}
                    disabled={pickedUserId === "" || actorId === null}
                    disabledHint={t("admin.roles.grantForm.pickFirst")}
                    title={t("admin.roles.grant.title", { role: ROLE_LABEL[pickedRole] })}
                    description={t("admin.roles.grant.description", {
                      role: ROLE_LABEL[pickedRole],
                      name:
                        profileNames.get(pickedUserId)?.name ?? t("admin.roles.unknownHolder"),
                    })}
                    onConfirm={async (reason) => {
                      if (actorId === null) return;
                      const done = await withStepUp(grantNeedsStepUp, () =>
                        grant.saveAsync(
                          { userId: pickedUserId, role: pickedRole, grantedBy: actorId },
                          reason,
                        ),
                      );
                      if (done) {
                        toast.success(
                          t("admin.roles.granted", { role: ROLE_LABEL[pickedRole] }),
                        );
                        setPickedUserId("");
                      }
                    }}
                  />
                </div>
              </div>
              <Notice tone="info" className="mt-4">
                {t("admin.roles.notice.noSuperGrant")}
              </Notice>
              {grant.userMessage !== null ? (
                <Notice tone="error" className="mt-3">
                  {grant.userMessage}
                </Notice>
              ) : null}
            </>
          )}
        </div>
      </section>

      {/* ── Grant register ───────────────────────────────────────────────── */}
      <section className="mt-6">
        <h2 className="mb-3 font-display text-base font-semibold">
          {t("admin.roles.grants.title")}
        </h2>
        <StateBoundary
          loading={grants.isPending}
          error={grants.error}
          onRetry={() => void grants.refetch()}
          isEmpty={grants.isSuccess && grantRows.length === 0}
          partialError={profiles.error}
          partialLabel={t("admin.roles.partial.names")}
          empty={
            <EmptyState
              icon={Users}
              title={t("admin.roles.grants.empty.title")}
              hint={t("admin.roles.grants.empty.hint")}
            />
          }
          skeletonRows={4}
        >
          <DataGrid
            columns={grantColumns}
            rows={grantRows}
            rowKey={(row) => row.grant.id}
            pageSize={25}
          />
        </StateBoundary>
      </section>

      {/* ── Scope register ───────────────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="mb-1 font-display text-base font-semibold">
          {t("admin.roles.scope.title")}
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">{t("admin.roles.scope.subtitle")}</p>
        <StateBoundary
          loading={assignments.isPending}
          error={assignments.error}
          onRetry={() => void assignments.refetch()}
          isEmpty={assignments.isSuccess && (assignments.data?.length ?? 0) === 0}
          empty={
            <EmptyState
              icon={Users}
              title={t("admin.roles.scope.empty.title")}
              hint={t("admin.roles.scope.empty.hint")}
            />
          }
          skeletonRows={3}
        >
          <DataGrid
            columns={assignmentColumns}
            rows={assignments.data ?? []}
            rowKey={(row) => row.id}
            pageSize={25}
          />
        </StateBoundary>
      </section>

      {/* ── Capability matrix ────────────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="mb-1 font-display text-base font-semibold">
          {t("admin.roles.matrix.title")}
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">{t("admin.roles.matrix.subtitle")}</p>
        <Notice tone="info" className="mb-3">
          {t("roles.matrix.nesting")}
        </Notice>
        {/* The matrix is the ROLE model; RLS is the boundary and is narrower for
            `attendance.lock.manage` (admin may take a soft lock only — unlock is
            an UPDATE and `attendance_locks__super_update` is super-admin) and for
            `kiosk.device.manage` (`kiosk_devices` is admin-READ / super-WRITE).
            Migration 170 corrects both descriptions; this says it once in prose
            so a reader is not misled by a tick. */}
        <Notice tone="warning" className="mb-3">
          {t("roles.matrix.narrowerNote")}
        </Notice>
        <Notice tone="info" className="mb-3">
          {t("admin.roles.notice.matrixReadOnly")}
        </Notice>
        <StateBoundary
          loading={capabilities.isPending}
          error={capabilities.error}
          onRetry={() => void capabilities.refetch()}
          isEmpty={capabilities.isSuccess && matrixRows.length === 0}
          empty={
            <EmptyState
              icon={ShieldCheck}
              title={t("admin.roles.matrix.empty.title")}
              hint={t("admin.roles.matrix.empty.hint")}
            />
          }
          skeletonRows={6}
        >
          <DataGrid
            columns={matrixColumns}
            rows={matrixRows}
            rowKey={(row) => row.capability}
            pageSize={50}
          />
        </StateBoundary>
      </section>

      <p className="mt-6 text-xs text-muted-foreground">{t("admin.roles.footnote")}</p>
      {stepUp.dialog}
    </div>
  );
}
