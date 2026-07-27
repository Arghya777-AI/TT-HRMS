/**
 * A-SET-02 · /admin/settings/flags — feature flags (spec-admin §15.3).
 *
 * `feature_flags` is SELECT for any authenticated user and FOR ALL to
 * `super_admin` only, so a plain admin sees the truthful state of every flag and
 * none of the switches. That is the honest shape of the deployed policy: hiding
 * the list would hide why a feature is off, and offering a switch that RLS will
 * refuse is worse than not offering it.
 *
 * §15.3 says "toggle = reason", and every toggle here goes through
 * `ReasonDialog` at the fuller D-21 length. There is no default reason on this
 * screen at all: `useFeatureFlagMutation` declares none, so a caller that
 * forgets to prompt fails on the client rather than writing an unexplained row.
 *
 * `expires_at` is rendered as a first-class column because an expired flag is a
 * decision nobody has made yet — the register exists to make that visible.
 *
 * @route /admin/settings/flags
 */
import { useMemo } from "react";
import { Cog, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import type { StatusChipEntry } from "@/shared/ui/StatusChip";
import { fmtDateTime, isFutureInstant } from "@/lib/datetime";
import { dash, formatNumber, formatPercent } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { useAuth } from "@/app/auth/AuthProvider";
import type { FeatureFlag } from "../api/system.api";
import { useFeatureFlagMutation, useFeatureFlags } from "../hooks/useSettingsConsole";
import { ReasonActionButton } from "../components/ReasonActionButton";

type FlagState = "on" | "off" | "targeted" | "killed";

/** Presentation mapping over the row's own columns — nothing is inferred. */
function flagState(flag: FeatureFlag): FlagState {
  if (flag.kill_switch) return "killed";
  if (!flag.is_enabled) return "off";
  const targeted =
    (flag.rollout_pct !== null && flag.rollout_pct < 100) ||
    (flag.enabled_for_roles?.length ?? 0) > 0 ||
    (flag.enabled_for_department_ids?.length ?? 0) > 0 ||
    (flag.enabled_for_profile_ids?.length ?? 0) > 0;
  return targeted ? "targeted" : "on";
}

const STATE_CHIP: Readonly<Record<FlagState, StatusChipEntry>> = {
  on: { label: t("admin.settings.flags.state.on"), tone: "success" },
  off: { label: t("admin.settings.flags.state.off"), tone: "neutral" },
  targeted: { label: t("admin.settings.flags.state.targeted"), tone: "info" },
  killed: { label: t("admin.settings.flags.state.killed"), tone: "danger" },
};

function isExpired(flag: FeatureFlag): boolean {
  return flag.expires_at !== null && !isFutureInstant(flag.expires_at);
}

export default function FeatureFlagsPage() {
  const { can } = useAuth();
  const isSuper = can("admin.super");
  const flags = useFeatureFlags();
  const toggle = useFeatureFlagMutation();

  const rows = flags.data ?? [];
  const onCount = rows.filter((f) => flagState(f) === "on" || flagState(f) === "targeted").length;
  const killedCount = rows.filter((f) => f.kill_switch).length;
  const expiredCount = rows.filter(isExpired).length;

  const columns: DataGridColumn<FeatureFlag>[] = useMemo(
    () => [
      {
        key: "flag",
        header: t("admin.settings.flags.col.flag"),
        sortable: true,
        sortValue: (row) => row.key,
        render: (row) => (
          <span className="flex flex-col leading-tight">
            <span className="text-sm font-medium">{row.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{row.key}</span>
            {row.description !== null ? (
              <span className="mt-0.5 max-w-md text-xs text-muted-foreground">{row.description}</span>
            ) : null}
          </span>
        ),
      },
      {
        key: "state",
        header: t("admin.settings.flags.col.state"),
        width: "10rem",
        render: (row) => {
          const state = flagState(row);
          return <StatusChip status={state} map={{ [state]: STATE_CHIP[state] }} />;
        },
      },
      {
        key: "rollout_pct",
        header: t("admin.settings.flags.col.rollout"),
        align: "right",
        width: "8rem",
        hideBelow: "md",
        // Already a percentage in the column; clamped so a bad row can never
        // render 1,700% (DR-01).
        render: (row) => dash(row.rollout_pct, (v) => formatPercent(v, { digits: 0, clamp: true })),
      },
      {
        key: "targeting",
        header: t("admin.settings.flags.col.targeting"),
        hideBelow: "lg",
        render: (row) => {
          const parts: string[] = [];
          const roles = row.enabled_for_roles?.length ?? 0;
          const departments = row.enabled_for_department_ids?.length ?? 0;
          const people = row.enabled_for_profile_ids?.length ?? 0;
          if (roles > 0) parts.push(t("admin.settings.flags.targeting.roles", { count: roles }));
          if (departments > 0) {
            parts.push(t("admin.settings.flags.targeting.departments", { count: departments }));
          }
          if (people > 0) parts.push(t("admin.settings.flags.targeting.people", { count: people }));
          if (parts.length === 0) parts.push(t("admin.settings.flags.targeting.everyone"));
          return <span className="text-xs text-muted-foreground">{parts.join(" · ")}</span>;
        },
      },
      {
        key: "owner",
        header: t("admin.settings.flags.col.owner"),
        hideBelow: "lg",
        render: (row) => dash(row.owner),
      },
      {
        key: "expires_at",
        header: t("admin.settings.flags.col.expires"),
        hideBelow: "md",
        sortable: true,
        render: (row) => {
          if (row.expires_at === null) {
            return (
              <span className="text-xs text-muted-foreground">
                {t("admin.settings.flags.permanent")}
              </span>
            );
          }
          return (
            <span className="flex flex-col leading-tight">
              <span className="num text-sm">{fmtDateTime(row.expires_at)}</span>
              {isExpired(row) ? (
                <Badge variant="warning">{t("admin.settings.flags.expired")}</Badge>
              ) : null}
            </span>
          );
        },
      },
      {
        key: "actions",
        header: t("admin.settings.flags.col.actions"),
        align: "right",
        width: "17rem",
        render: (row) => {
          if (!isSuper) {
            return (
              <span className="text-xs text-muted-foreground">{t("admin.console.superOnly")}</span>
            );
          }
          return (
            <span className="inline-flex flex-wrap items-center justify-end gap-1">
              {row.is_enabled ? (
                <ReasonActionButton
                  label={t("admin.settings.flags.action.disable")}
                  minLength={toggle.minReasonLength}
                  title={t("admin.settings.flags.disable.title", { name: row.name })}
                  description={t("admin.settings.flags.disable.description")}
                  onConfirm={async (reason) => {
                    await toggle.saveAsync({ id: row.id, patch: { is_enabled: false } }, reason);
                    toast.success(t("admin.settings.flags.saved", { name: row.name }));
                  }}
                />
              ) : (
                <ReasonActionButton
                  label={t("admin.settings.flags.action.enable")}
                  variant="default"
                  minLength={toggle.minReasonLength}
                  title={t("admin.settings.flags.enable.title", { name: row.name })}
                  description={t("admin.settings.flags.enable.description")}
                  onConfirm={async (reason) => {
                    await toggle.saveAsync({ id: row.id, patch: { is_enabled: true } }, reason);
                    toast.success(t("admin.settings.flags.saved", { name: row.name }));
                  }}
                />
              )}
              {row.kill_switch ? (
                <ReasonActionButton
                  label={t("admin.settings.flags.action.unkill")}
                  variant="ghost"
                  minLength={toggle.minReasonLength}
                  title={t("admin.settings.flags.unkill.title", { name: row.name })}
                  description={t("admin.settings.flags.unkill.description")}
                  onConfirm={async (reason) => {
                    await toggle.saveAsync({ id: row.id, patch: { kill_switch: false } }, reason);
                    toast.success(t("admin.settings.flags.saved", { name: row.name }));
                  }}
                />
              ) : (
                <ReasonActionButton
                  label={t("admin.settings.flags.action.kill")}
                  variant="destructive"
                  minLength={toggle.minReasonLength}
                  title={t("admin.settings.flags.kill.title", { name: row.name })}
                  description={t("admin.settings.flags.kill.description")}
                  onConfirm={async (reason) => {
                    await toggle.saveAsync({ id: row.id, patch: { kill_switch: true } }, reason);
                    toast.success(t("admin.settings.flags.saved", { name: row.name }));
                  }}
                />
              )}
            </span>
          );
        },
      },
    ],
    [isSuper, toggle],
  );

  return (
    <div className="container py-6">
      <PageHeader
        icon={Cog}
        title={t("admin.settings.flags.title")}
        subtitle={t("admin.settings.flags.subtitle")}
      />

      {!isSuper ? (
        <p
          className="mb-4 flex items-start gap-2 rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground"
          role="status"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {t("admin.settings.flags.superOnlyHint")}
        </p>
      ) : null}

      <StateBoundary
        loading={flags.isLoading}
        error={flags.error ?? undefined}
        onRetry={() => void flags.refetch()}
        isEmpty={flags.isSuccess && rows.length === 0}
        empty={
          <EmptyState
            icon={Cog}
            title={t("admin.settings.flags.empty.title")}
            hint={t("admin.settings.flags.empty.hint")}
          />
        }
        skeletonRows={5}
      >
        <section className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <KpiTile
            label={t("admin.settings.flags.kpi.on")}
            value={formatNumber(onCount)}
            tone={onCount > 0 ? "success" : "neutral"}
          />
          <KpiTile
            label={t("admin.settings.flags.kpi.killed")}
            value={formatNumber(killedCount)}
            tone={killedCount > 0 ? "danger" : "neutral"}
          />
          <KpiTile
            label={t("admin.settings.flags.kpi.expired")}
            value={formatNumber(expiredCount)}
            tone={expiredCount > 0 ? "warn" : "success"}
            {...(expiredCount > 0 ? { hint: t("admin.settings.flags.expiredHint") } : {})}
          />
        </section>

        <DataGrid columns={columns} rows={rows} rowKey={(row) => row.id} pageSize={25} />

        <p className="mt-3 text-xs text-muted-foreground">{t("admin.settings.flags.expiryNote")}</p>
      </StateBoundary>
    </div>
  );
}
