/**
 * A-SET-03 · /admin/settings/health — component checks, scheduled jobs and the
 * kiosk fleet (spec-admin §15.10).
 *
 * Three admin-readable relations, each rendered as itself:
 *   * `system_health` — one row per component check. Admin SELECT plus admin
 *     UPDATE, which is the acknowledge path and the only write on this screen.
 *   * `job_runs` — cron and edge job history. There is no INSERT grant for
 *     `authenticated`, deliberately: a job is started by cron or by an edge
 *     function, never by a browser. The screen therefore reads history and says
 *     so instead of offering a "run now" button that cannot work.
 *   * `kiosk_devices` + `v_kiosk_health` — the fleet band, which links to the
 *     kiosk console rather than duplicating its grid.
 *
 * Every tile is a count of the rows rendered below it, so a tile and its list can
 * never disagree (DR-29). Nothing on this screen is averaged.
 *
 * @route /admin/settings/health
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Activity, Gauge, ScanFace } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtDateTime, minutesSince, nowIstDate } from "@/lib/datetime";
import { dash, formatNumber, formatPercent } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { useAuth } from "@/app/auth/AuthProvider";
import type { JobRun, SystemHealthRow } from "../api/health.api";
import type { KioskDevice, KioskHealthRow } from "../api/system.api";
import {
  useCronJobs,
  useHealthAckMutation,
  useJobRuns,
  useSystemHealth,
} from "../hooks/useSettingsConsole";
import { useKioskDevices, useKioskHealth } from "../hooks/useKioskConsole";
import { deviceState, type DeviceState } from "../api/kiosk.api";
import { deviceStateChip, healthChip } from "../kiosk-display";
import { ReasonActionButton } from "../components/ReasonActionButton";

/** Seeded `kiosk.offline_alert_minutes`; the fleet band's quiet threshold. */
const KIOSK_QUIET_MINUTES = 10;

export default function SystemHealthPage() {
  const { user } = useAuth();
  const [onlyOpen, setOnlyOpen] = useState(true);

  const checks = useSystemHealth({ onlyOpen });
  const allChecks = useSystemHealth({});
  const jobs = useJobRuns();
  const crons = useCronJobs();
  const devices = useKioskDevices();
  const today = nowIstDate();
  const kioskToday = useKioskHealth(today, today);
  const ack = useHealthAckMutation();

  const checkRows = checks.data ?? [];
  const openRows = (allChecks.data ?? []).filter(
    (r) => r.resolved_at === null && r.status !== "ok",
  );
  const downCount = openRows.filter((r) => r.status === "down").length;
  const degradedCount = openRows.filter((r) => r.status === "degraded").length;

  const jobRows = jobs.data ?? [];
  const failedJobs = jobRows.filter((r) => r.status === "failed").length;
  const cronRows = crons.data ?? [];
  const cronEnabled = cronRows.filter((c) => c.is_enabled).length;

  const kioskByDevice = useMemo(() => {
    const map = new Map<string, KioskHealthRow>();
    for (const row of kioskToday.data ?? []) map.set(row.kiosk_device_id, row);
    return map;
  }, [kioskToday.data]);

  const fleet = useMemo(
    () =>
      (devices.data ?? []).map((device) => {
        const quiet = device.last_seen_at === null ? null : minutesSince(device.last_seen_at);
        return {
          device,
          state: deviceState(device, quiet, KIOSK_QUIET_MINUTES),
          today: kioskByDevice.get(device.id) ?? null,
        };
      }),
    [devices.data, kioskByDevice],
  );
  const quietKiosks = fleet.filter(
    (row) => row.state === "offline" || row.state === "pending_pairing",
  ).length;

  const checkColumns: DataGridColumn<SystemHealthRow>[] = [
    {
      key: "component",
      header: t("admin.settings.health.checks.col.component"),
      sortable: true,
      render: (row) => <span className="font-mono text-xs">{row.component}</span>,
    },
    {
      key: "status",
      header: t("admin.settings.health.checks.col.status"),
      width: "9rem",
      render: (row) => <StatusChip status={row.status} map={healthChip(row.status)} />,
    },
    {
      key: "metric",
      header: t("admin.settings.health.checks.col.metric"),
      hideBelow: "md",
      render: (row) => {
        if (row.metric_name === null) return dash(null);
        return (
          <span className="flex flex-col leading-tight">
            <span className="num text-sm">
              {t("admin.settings.health.metric", {
                name: row.metric_name,
                value: row.metric_value === null ? t("common.empty") : formatNumber(row.metric_value),
              })}
            </span>
            {row.threshold !== null ? (
              <span className="text-xs text-muted-foreground">
                {t("admin.settings.health.threshold", { value: formatNumber(row.threshold) })}
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: "checked_at",
      header: t("admin.settings.health.checks.col.checked"),
      hideBelow: "md",
      sortable: true,
      render: (row) => <span className="num text-sm">{fmtDateTime(row.checked_at)}</span>,
    },
    {
      key: "message",
      header: t("admin.settings.health.checks.col.detail"),
      render: (row) => (
        <span className="block max-w-md break-words text-xs text-muted-foreground">
          {dash(row.message)}
        </span>
      ),
    },
    {
      key: "ack",
      header: t("admin.settings.health.checks.col.ack"),
      align: "right",
      width: "14rem",
      render: (row) => {
        if (row.acknowledged_at !== null) {
          return (
            <span className="num text-xs text-muted-foreground">{fmtDateTime(row.acknowledged_at)}</span>
          );
        }
        if (row.status === "ok" || user === null) return dash(null);
        return (
          <ReasonActionButton
            label={t("admin.settings.health.action.ack")}
            onConfirm={async (reason) => {
              await ack.saveAsync({ id: row.id, profileId: user.id }, reason);
              toast.success(t("admin.settings.health.acked"));
            }}
            title={t("admin.settings.health.action.ack")}
            description={row.message ?? row.component}
          />
        );
      },
    },
  ];

  const jobColumns: DataGridColumn<JobRun>[] = [
    {
      key: "job_code",
      header: t("admin.settings.health.jobs.col.job"),
      sortable: true,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="font-mono text-xs">{row.job_code}</span>
          {row.attempt > 1 ? (
            <span className="text-xs text-warning">
              {t("admin.settings.health.jobs.attempt", { n: row.attempt })}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "run_kind",
      header: t("admin.settings.health.jobs.col.kind"),
      hideBelow: "lg",
      render: (row) => <StatusChip status={row.run_kind} />,
    },
    {
      key: "status",
      header: t("admin.settings.health.jobs.col.status"),
      width: "9rem",
      render: (row) => <StatusChip status={row.status} />,
    },
    {
      key: "started_at",
      header: t("admin.settings.health.jobs.col.started"),
      sortable: true,
      hideBelow: "md",
      render: (row) => <span className="num text-sm">{fmtDateTime(row.started_at)}</span>,
    },
    {
      key: "duration_ms",
      header: t("admin.settings.health.jobs.col.duration"),
      align: "right",
      hideBelow: "md",
      render: (row) =>
        row.duration_ms === null
          ? dash(null)
          : t("admin.settings.health.jobs.ms", { ms: formatNumber(row.duration_ms) }),
    },
    {
      key: "records",
      header: t("admin.settings.health.jobs.col.records"),
      align: "right",
      hideBelow: "lg",
      render: (row) => {
        if (row.records_processed === null && row.records_failed === null) return dash(null);
        return (
          <span className="num text-xs">
            {t("admin.settings.health.jobs.records", {
              done: formatNumber(row.records_processed ?? 0),
              failed: formatNumber(row.records_failed ?? 0),
            })}
          </span>
        );
      },
    },
    {
      key: "error",
      header: t("admin.settings.health.jobs.col.error"),
      render: (row) => (
        <span className="block max-w-sm break-words text-xs text-destructive">
          {dash(row.error)}
        </span>
      ),
    },
  ];

  const fleetColumns: DataGridColumn<{
    device: KioskDevice;
    state: DeviceState;
    today: KioskHealthRow | null;
  }>[] = [
    {
      key: "device",
      header: t("admin.kiosk.devices.col.device"),
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="font-mono text-xs">{row.device.device_code}</span>
          <span className="text-sm">{row.device.label}</span>
        </span>
      ),
    },
    {
      key: "state",
      header: t("admin.kiosk.devices.col.state"),
      width: "10rem",
      render: (row) => <StatusChip status={row.state} map={deviceStateChip(row.state)} />,
    },
    {
      key: "lastSeen",
      header: t("admin.kiosk.devices.col.lastSeen"),
      hideBelow: "md",
      render: (row) => dash(row.device.last_seen_at, fmtDateTime),
    },
    {
      key: "matchRate",
      header: t("admin.kiosk.devices.col.matchRate"),
      align: "right",
      render: (row) => dash(row.today?.match_success_pct ?? null, (v) => formatPercent(v)),
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={Gauge}
        title={t("admin.settings.health.title")}
        subtitle={t("admin.settings.health.subtitle")}
      />

      <StateBoundary
        loading={allChecks.isLoading}
        error={allChecks.error ?? undefined}
        onRetry={() => void allChecks.refetch()}
        partialError={jobs.error ?? devices.error ?? kioskToday.error ?? crons.error ?? undefined}
        partialLabel={t("admin.settings.health.jobs.title")}
        skeletonRows={4}
      >
        <section className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <KpiTile
            label={t("admin.settings.health.kpi.open")}
            value={formatNumber(openRows.length)}
            tone={openRows.length > 0 ? "warn" : "success"}
            hint={t("admin.settings.health.kpi.openHint")}
          />
          <KpiTile
            label={t("admin.settings.health.kpi.down")}
            value={formatNumber(downCount)}
            tone={downCount > 0 ? "danger" : "success"}
          />
          <KpiTile
            label={t("admin.settings.health.kpi.degraded")}
            value={formatNumber(degradedCount)}
            tone={degradedCount > 0 ? "warn" : "success"}
          />
          <KpiTile
            label={t("admin.settings.health.kpi.jobsFailed")}
            value={formatNumber(failedJobs)}
            tone={failedJobs > 0 ? "danger" : "success"}
            hint={t("admin.settings.health.kpi.jobsHint", { total: formatNumber(jobRows.length) })}
          />
          <KpiTile
            label={t("admin.settings.health.kpi.kiosksQuiet")}
            value={formatNumber(quietKiosks)}
            tone={quietKiosks > 0 ? "warn" : "success"}
            hint={t("admin.settings.health.kpi.kiosksHint", {
              minutes: formatNumber(KIOSK_QUIET_MINUTES),
            })}
          />
        </section>
      </StateBoundary>

      <h2 className="mb-3 font-display text-lg font-semibold">
        {t("admin.settings.health.checks.title")}
      </h2>

      <StateBoundary
        loading={checks.isLoading}
        error={checks.error ?? undefined}
        onRetry={() => void checks.refetch()}
        skeletonRows={4}
      >
        <DataGrid
          columns={checkColumns}
          rows={checkRows}
          rowKey={(row) => row.id}
          pageSize={25}
          toolbar={
            <div className="flex flex-wrap gap-1" role="group">
              <Button
                size="sm"
                variant={onlyOpen ? "default" : "outline"}
                aria-pressed={onlyOpen}
                onClick={() => setOnlyOpen(true)}
              >
                {t("admin.settings.health.filter.open")}
              </Button>
              <Button
                size="sm"
                variant={onlyOpen ? "outline" : "default"}
                aria-pressed={!onlyOpen}
                onClick={() => setOnlyOpen(false)}
              >
                {t("admin.settings.health.filter.all")}
              </Button>
            </div>
          }
          emptyState={
            onlyOpen ? (
              <EmptyState
                icon={Activity}
                title={t("admin.settings.health.checks.emptyOpen.title")}
                hint={t("admin.settings.health.checks.emptyOpen.hint")}
                action={
                  <Button variant="outline" onClick={() => setOnlyOpen(false)}>
                    {t("admin.settings.health.filter.all")}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={Activity}
                title={t("admin.settings.health.checks.empty.title")}
                hint={t("admin.settings.health.checks.empty.hint")}
              />
            )
          }
        />
      </StateBoundary>

      <h2 className="mb-3 mt-8 font-display text-lg font-semibold">
        {t("admin.settings.health.jobs.title")}
      </h2>

      <StateBoundary
        loading={jobs.isLoading}
        error={jobs.error ?? undefined}
        onRetry={() => void jobs.refetch()}
        partialError={crons.error ?? undefined}
        partialLabel={t("admin.settings.health.jobs.col.job")}
        skeletonRows={4}
      >
        {cronRows.length > 0 ? (
          <div className="mb-2 text-xs text-muted-foreground">
            <Badge variant="neutral">
              {t("admin.settings.health.jobs.enabled", {
                on: formatNumber(cronEnabled),
                total: formatNumber(cronRows.length),
              })}
            </Badge>
          </div>
        ) : null}
        <DataGrid
          columns={jobColumns}
          rows={jobRows}
          rowKey={(row) => row.id}
          pageSize={25}
          emptyState={
            <EmptyState
              icon={Activity}
              title={t("admin.settings.health.jobs.empty.title")}
              hint={t("admin.settings.health.jobs.empty.hint")}
            />
          }
        />
        <p className="mt-3 text-xs text-muted-foreground">
          {t("admin.settings.health.jobs.readOnly")}
        </p>
      </StateBoundary>

      <h2 className="mb-3 mt-8 font-display text-lg font-semibold">
        {t("admin.settings.health.fleet.title")}
      </h2>

      <StateBoundary
        loading={devices.isLoading}
        error={devices.error ?? undefined}
        onRetry={() => void devices.refetch()}
        partialError={kioskToday.error ?? undefined}
        partialLabel={t("admin.kiosk.devices.col.matchRate")}
        skeletonRows={3}
      >
        <DataGrid
          columns={fleetColumns}
          rows={fleet}
          rowKey={(row) => row.device.id}
          pageSize={10}
          emptyState={
            <EmptyState
              icon={ScanFace}
              title={t("admin.settings.health.fleet.empty.title")}
              hint={t("admin.settings.health.fleet.empty.hint")}
            />
          }
        />
        <p className="mt-3 text-xs">
          <Link className="underline underline-offset-4" to="/admin/kiosk/devices">
            {t("admin.settings.health.fleet.link")}
          </Link>
        </p>
      </StateBoundary>
    </div>
  );
}
