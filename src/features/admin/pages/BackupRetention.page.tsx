/**
 * A-SET-11 · /admin/settings/backup — "Backup state, restore drills and
 * retention" (route manifest), spec-admin §15.10.
 *
 * Of the three things the title promises, the deployed schema exposes exactly
 * one, and this screen is arranged around that fact.
 *
 * READABLE — RETENTION IS REAL:
 *  * `public.cron_jobs` (migration 041) holds `retention_sweep`, scheduled daily
 *    at 22:00 IST, whose own description enumerates what it deletes: it nulls
 *    `face_match_log.candidate_scores` past 90 days, deletes kiosk punch photos
 *    past `settings.kiosk.retain_punch_photos_days`, archives audit partitions
 *    beyond 25 months, purges `webauthn_challenges` and expires signed URLs —
 *    "Every deletion writes audit_log." It also holds `biometric_purge`, which is
 *    `is_enabled = false` BY DESIGN ("Never scheduled", super-admin initiated
 *    only), so this screen must not render that as a fault.
 *  * `public.job_runs` gives the sweep's actual history — status, duration, rows
 *    processed and failed. A retention policy nobody can prove ran is not a
 *    policy, so the run register is the evidence half of this page.
 *  * The two `settings` rows the sweep literally reads are editable here through
 *    the same reason-prompted `SettingRow` as every other settings screen.
 *
 * NOT READABLE, and therefore not shown as a number or a button:
 *  * There is no `backups` table. Postgres backups and point-in-time recovery are
 *    Supabase PLATFORM state, exposed through the Supabase dashboard and
 *    Management API — never to an application's anon/authenticated client. So
 *    "last backup at" cannot be stated here, and a plausible-looking timestamp
 *    would be a fabrication about disaster recovery, which is the worst possible
 *    subject to guess about.
 *  * There is no `restore_drills` table, so §15.10's drill log and "last verified
 *    restore" have no store. Nothing is inferred from job history: a retention
 *    sweep succeeding says nothing about whether a restore would work.
 *  * There is no `retention_policies` table — retention lives in the two settings
 *    keys above plus constants inside `public.retention_sweep()`, so there is no
 *    per-table policy grid to edit.
 *  * `biometric_purge` runs via the `admin-biometric-purge` edge function and is
 *    owned by /admin/kiosk/purge; it is listed here as schedule state only and
 *    deliberately offers no trigger.
 *
 * No client arithmetic: durations and record counts are server columns, the
 * schedule sentence is `schedule_human` from the database rather than a cron
 * expression this screen tries to translate.
 *
 * @route /admin/settings/backup
 */
import { useMemo } from "react";
import { Cog, DatabaseBackup, HardDriveDownload, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { useAuth } from "@/app/auth/AuthProvider";
import { fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { SettingRow } from "../components/SettingRow";
import type { Setting } from "../api/system.api";
import type { JobRun } from "../api/health.api";
import type { CronSchedule } from "../api/settings-extra.api";
import { useJobRuns, useSettingMutation } from "../hooks/useSettingsConsole";
import { useCronSchedules, useSettingsByKeys } from "../hooks/useSettingsExtra";

/** The two schedules this screen is about — filtered SERVER-side by code. */
const RETENTION_CODE = "retention_sweep";
const SCHEDULE_CODES: readonly string[] = [RETENTION_CODE, "biometric_purge"];

/**
 * The settings rows `retention_sweep()` actually reads. Both were verified in
 * migration 046's seed; no retention key is invented.
 */
const RETENTION_KEYS: readonly string[] = [
  "kiosk.retain_punch_photos_days",
  "security.export_retention_days",
];

/** `job_runs.status` — 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'. */
const RUN_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  running: { label: t("admin.backup.run.running"), tone: "info" },
  succeeded: { label: t("admin.backup.run.succeeded"), tone: "success" },
  failed: { label: t("admin.backup.run.failed"), tone: "danger" },
  skipped: { label: t("admin.backup.run.skipped"), tone: "neutral" },
  cancelled: { label: t("admin.backup.run.cancelled"), tone: "warn" },
};

export default function BackupRetentionPage() {
  const { can } = useAuth();
  const isSuper = can("admin.super");

  const schedules = useCronSchedules(SCHEDULE_CODES);
  const runs = useJobRuns({ jobCode: RETENTION_CODE });
  const settings = useSettingsByKeys(RETENTION_KEYS);
  const save = useSettingMutation();

  const scheduleRows = useMemo(() => schedules.data ?? [], [schedules.data]);
  const runRows = useMemo(() => runs.data ?? [], [runs.data]);
  const settingRows = useMemo(() => settings.data ?? [], [settings.data]);

  const sweep = useMemo(
    () => scheduleRows.find((row) => row.code === RETENTION_CODE) ?? null,
    [scheduleRows],
  );

  /** The most recent run is the first row: `job_runs` is ordered started_at desc. */
  const lastRun = runRows[0] ?? null;

  async function persist(setting: Setting, value: unknown, reason: string): Promise<void> {
    await save.saveAsync({ key: setting.key, value, groupName: setting.group_name }, reason);
    toast.success(t("admin.settings.row.saved", { label: setting.label }));
  }

  function canEdit(setting: Setting): boolean {
    return setting.is_editable_by_admin || isSuper;
  }

  const scheduleColumns: DataGridColumn<CronSchedule>[] = [
    {
      key: "name",
      header: t("admin.backup.schedule.col.job"),
      width: "16rem",
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="text-sm font-medium">{row.name}</span>
          <span className="font-mono text-xs text-muted-foreground">{row.code}</span>
        </span>
      ),
    },
    {
      key: "schedule_human",
      header: t("admin.backup.schedule.col.when"),
      width: "14rem",
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="text-sm">{row.schedule_human}</span>
          <span className="font-mono text-xs text-muted-foreground">
            {t("admin.backup.schedule.tz", { cron: row.schedule_cron, tz: row.timezone })}
          </span>
        </span>
      ),
    },
    {
      key: "is_enabled",
      header: t("admin.backup.schedule.col.state"),
      width: "11rem",
      render: (row) => (
        <span className="flex flex-col items-start gap-1">
          <Badge variant={row.is_enabled ? "success" : "neutral"}>
            {row.is_enabled
              ? t("admin.backup.schedule.scheduled")
              : t("admin.backup.schedule.manualOnly")}
          </Badge>
          {row.alert_on_failure ? (
            <span className="text-xs text-muted-foreground">
              {t("admin.backup.schedule.alerts")}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "next_run_at",
      header: t("admin.backup.schedule.col.next"),
      width: "13rem",
      hideBelow: "md",
      render: (row) => (
        <span className="num">
          {row.next_run_at === null
            ? t("admin.backup.schedule.noNextRun")
            : fmtDateTime(row.next_run_at)}
        </span>
      ),
    },
    {
      key: "target_name",
      header: t("admin.backup.schedule.col.target"),
      hideBelow: "lg",
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="font-mono text-xs">{row.target_name}</span>
          {row.description !== null ? (
            <span className="mt-0.5 max-w-lg text-xs text-muted-foreground">
              {row.description}
            </span>
          ) : null}
        </span>
      ),
    },
  ];

  const runColumns: DataGridColumn<JobRun>[] = [
    {
      key: "status",
      header: t("admin.backup.runs.col.status"),
      width: "9rem",
      render: (row) => <StatusChip status={row.status} map={RUN_CHIP} />,
    },
    {
      key: "started_at",
      header: t("admin.backup.runs.col.started"),
      width: "13rem",
      sortable: true,
      sortValue: (row) => row.started_at,
      render: (row) => <span className="num">{fmtDateTime(row.started_at)}</span>,
    },
    {
      key: "duration_ms",
      header: t("admin.backup.runs.col.duration"),
      align: "right",
      width: "9rem",
      render: (row) =>
        row.duration_ms === null
          ? dash(null)
          : t("admin.settings.health.jobs.ms", { ms: formatNumber(row.duration_ms) }),
    },
    {
      key: "records_processed",
      header: t("admin.backup.runs.col.processed"),
      align: "right",
      width: "9rem",
      hideBelow: "md",
      render: (row) => dash(row.records_processed, formatNumber),
    },
    {
      key: "records_failed",
      header: t("admin.backup.runs.col.failed"),
      align: "right",
      width: "8rem",
      hideBelow: "md",
      render: (row) => dash(row.records_failed, formatNumber),
    },
    {
      key: "error",
      header: t("admin.backup.runs.col.error"),
      hideBelow: "lg",
      render: (row) => <span className="text-xs">{dash(row.error)}</span>,
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={DatabaseBackup}
        title={t("admin.backup.title")}
        subtitle={t("admin.backup.subtitle")}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <KpiTile
          label={t("admin.backup.kpi.sweep")}
          value={
            schedules.isPending
              ? t("app.loading")
              : sweep === null
                ? dash(null)
                : sweep.is_enabled
                  ? t("admin.backup.kpi.sweepOn")
                  : t("admin.backup.kpi.sweepOff")
          }
          hint={sweep === null ? t("admin.backup.kpi.sweepMissing") : sweep.schedule_human}
          tone={sweep !== null && !sweep.is_enabled ? "warn" : "neutral"}
        />
        <KpiTile
          label={t("admin.backup.kpi.nextRun")}
          value={
            schedules.isPending
              ? t("app.loading")
              : sweep === null || sweep.next_run_at === null
                ? dash(null)
                : fmtDateTime(sweep.next_run_at)
          }
          hint={t("admin.backup.kpi.nextRunHint")}
        />
        <KpiTile
          label={t("admin.backup.kpi.lastRun")}
          value={
            runs.isPending
              ? t("app.loading")
              : lastRun === null
                ? dash(null)
                : (RUN_CHIP[lastRun.status]?.label ?? dash(null))
          }
          hint={
            lastRun === null
              ? t("admin.backup.kpi.lastRunNone")
              : t("admin.backup.kpi.lastRunAt", { when: fmtDateTime(lastRun.started_at) })
          }
          tone={lastRun !== null && lastRun.status === "failed" ? "warn" : "neutral"}
        />
      </div>

      <Notice tone="warning" className="mt-4">
        {t("admin.backup.notice.noBackupTable")}
      </Notice>

      {/* ── Retention schedules ──────────────────────────────────────────── */}
      <section className="mt-6">
        <h2 className="mb-1 font-display text-base font-semibold">
          {t("admin.backup.schedule.title")}
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">{t("admin.backup.schedule.subtitle")}</p>
        <StateBoundary
          loading={schedules.isPending}
          error={schedules.error}
          onRetry={() => void schedules.refetch()}
          isEmpty={schedules.isSuccess && scheduleRows.length === 0}
          empty={
            <EmptyState
              icon={Cog}
              title={t("admin.backup.schedule.empty.title")}
              hint={t("admin.backup.schedule.empty.hint")}
            />
          }
          skeletonRows={2}
        >
          <DataGrid
            columns={scheduleColumns}
            rows={scheduleRows}
            rowKey={(row) => row.id}
            pageSize={10}
          />
        </StateBoundary>
      </section>

      {/* ── Sweep history ────────────────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="mb-1 font-display text-base font-semibold">
          {t("admin.backup.runs.title")}
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">{t("admin.backup.runs.subtitle")}</p>
        <StateBoundary
          loading={runs.isPending}
          error={runs.error}
          onRetry={() => void runs.refetch()}
          isEmpty={runs.isSuccess && runRows.length === 0}
          empty={
            <EmptyState
              icon={ShieldCheck}
              title={t("admin.backup.runs.empty.title")}
              hint={t("admin.backup.runs.empty.hint")}
            />
          }
          skeletonRows={4}
        >
          <DataGrid columns={runColumns} rows={runRows} rowKey={(row) => row.id} pageSize={25} />
        </StateBoundary>
      </section>

      {/* ── Retention windows (real settings rows) ───────────────────────── */}
      <section className="mt-8">
        <h2 className="mb-1 font-display text-base font-semibold">
          {t("admin.backup.windows.title")}
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">{t("admin.backup.windows.subtitle")}</p>
        <StateBoundary
          loading={settings.isPending}
          error={settings.error}
          onRetry={() => void settings.refetch()}
          isEmpty={settings.isSuccess && settingRows.length === 0}
          empty={
            <EmptyState
              icon={Cog}
              title={t("admin.backup.windows.empty.title")}
              hint={t("admin.backup.windows.empty.hint")}
            />
          }
          skeletonRows={2}
        >
          <div className="rounded-lg border bg-card">
            {settingRows.map((setting) => (
              <SettingRow
                key={setting.id}
                setting={setting}
                canEdit={canEdit(setting)}
                onSave={(value, reason) => persist(setting, value, reason)}
              />
            ))}
            <p className="border-t px-4 py-3 text-xs text-muted-foreground">
              {t("admin.backup.windows.note")}
            </p>
          </div>
        </StateBoundary>
        {save.userMessage !== null ? (
          <Notice tone="error" className="mt-3">
            {save.userMessage}
          </Notice>
        ) : null}
      </section>

      {/* ── Restore drills: no store at all ──────────────────────────────── */}
      <section className="mt-8">
        <h2 className="mb-1 font-display text-base font-semibold">
          {t("admin.backup.drills.title")}
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">{t("admin.backup.drills.subtitle")}</p>
        <EmptyState
          icon={HardDriveDownload}
          title={t("admin.backup.drills.empty.title")}
          hint={t("admin.backup.drills.empty.hint")}
        />
      </section>

      <p className="mt-6 text-xs text-muted-foreground">{t("admin.backup.footnote")}</p>
    </div>
  );
}
