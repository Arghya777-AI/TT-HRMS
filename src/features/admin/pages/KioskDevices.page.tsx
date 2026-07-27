/**
 * A-KIOSK-01 · /admin/kiosk/devices — the gate tablets, their health and their
 * pairing state (spec-admin §5.11).
 *
 * Where every number comes from, because "the fleet looked fine" is the failure
 * mode this screen exists to prevent:
 *   * The device row (`kiosk_devices`) owns last-seen, clock skew, app version
 *     and the accept threshold.
 *   * `v_kiosk_health` owns everything about SCANS — attempts, outcomes, match
 *     rate and the p50/p95 latency, one row per device per IST day. The match
 *     rate in each row is the view's own clamped percentage; this file never
 *     re-derives it, which is why a row and a tile cannot disagree.
 *   * There is no fleet-level health view, so the two fleet tiles are honest
 *     SUMS of the exact rows shown below them and say so in their explainer
 *     (DR-28). No fleet-wide percentage is asserted.
 *
 * Writes: `kiosk_devices` is admin-READ / super-admin-WRITE and reason-required,
 * so every action here is hidden from a plain admin rather than offered and then
 * refused by RLS.
 *
 * @route /admin/kiosk/devices
 */
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Clock, Plus, ScanFace, ShieldAlert, TabletSmartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import {
  fmtCivilDate,
  fmtDateTime,
  fmtMonthLong,
  isIstMonthKey,
  istMonthRange,
  minutesSince,
  nowIstDate,
  nowIstMonth,
} from "@/lib/datetime";
import { dash, formatNumber, formatPercent } from "@/lib/format";
import { asArray } from "@/lib/asArray";
import { KioskLinkCard } from "../components/KioskLinkCard";
import { t } from "@/shared/i18n/en";
import { useAuth } from "@/app/auth/AuthProvider";
import {
  CLOCK_SKEW_DEGRADED_SECONDS,
  deviceState,
  type DeviceState,
} from "../api/kiosk.api";
import type { KioskDevice, KioskHealthRow } from "../api/system.api";
import {
  useDevicePairingMutation,
  useDeviceThresholdMutation,
  useAddKioskDevice,
  useKioskDevices,
  useKioskHealth,
  useIssueActivationCode,
} from "../hooks/useKioskConsole";
import { useSettingsGroup } from "../hooks/useSettingsConsole";
import { deviceStateChip } from "../kiosk-display";
import { MonthStepper } from "../components/MonthStepper";
import { Notice } from "../components/Notice";
import { ReasonActionButton } from "../components/ReasonActionButton";
import { KioskSectionNav } from "../components/KioskSectionNav";

/** Seeded value of `kiosk.offline_alert_minutes`; used only if the row is absent. */
const OFFLINE_MINUTES_FALLBACK = 10;
const THRESHOLD_MIN = 0.4;
const THRESHOLD_MAX = 0.75;

/**
 * The "+ Add a gate device" button, defined once and rendered in three places.
 *
 * Three is deliberate, not sloppy, and each one covers a state the others do not:
 *   1. THE PAGE HEADER — outside `StateBoundary`, so it still works when the device
 *      list fails to load. Without it, a fetch error would leave no way to add one.
 *   2. ABOVE THE TABLE — the header scrolls off this page behind the tiles and the
 *      gate-link card, and an action nobody can see may as well not exist. This is
 *      where somebody looking at the fleet actually is.
 *   3. INSIDE THE EMPTY STATE — `StateBoundary` REPLACES its children when the fleet
 *      is empty, which would remove (2) at exactly the moment the first device needs
 *      adding.
 *
 * All three open the same reason dialog and call the same mutation, so they cannot
 * drift. The alternative — one button in one place — is what produced today's actual
 * bug report twice over.
 */
function AddDeviceButton({ onConfirm }: { onConfirm: (reason: string) => Promise<unknown> }) {
  return (
    <ReasonActionButton
      label={
        <span className="inline-flex items-center gap-1.5">
          <Plus className="h-4 w-4" aria-hidden />
          {t("admin.kiosk.devices.action.addDevice")}
        </span>
      }
      variant="default"
      title={t("admin.kiosk.devices.add.title")}
      description={t("admin.kiosk.devices.add.description")}
      minLength={10}
      onConfirm={onConfirm}
    />
  );
}

interface FleetRow {
  readonly device: KioskDevice;
  readonly today: KioskHealthRow | null;
  readonly state: DeviceState;
  readonly minutesQuiet: number | null;
}

export default function KioskDevicesPage() {
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const isSuper = can("admin.super");

  const requested = params.get("m");
  const month = requested !== null && isIstMonthKey(requested) ? requested : nowIstMonth();
  const range = useMemo(() => istMonthRange(month), [month]);
  const today = nowIstDate();

  const devices = useKioskDevices();
  const healthToday = useKioskHealth(today, today);
  const healthMonth = useKioskHealth(range.from, range.to);
  const kioskSettings = useSettingsGroup("kiosk");

  const pairing = useDevicePairingMutation();
  const threshold = useDeviceThresholdMutation();
  const issueCode = useIssueActivationCode();
  const addDevice = useAddKioskDevice();

  /**
   * Whichever action last produced a pairing code. Both results carry the same four
   * fields the panel needs, so the panel does not care which one it came from — and
   * only ever shows ONE code, so nobody reads out a stale one.
   */
  const pairingCode = addDevice.data ?? issueCode.data;

  const offlineMinutes = useMemo(() => {
    const row = (kioskSettings.data ?? []).find((s) => s.key === "kiosk.offline_alert_minutes");
    return typeof row?.value === "number" ? row.value : OFFLINE_MINUTES_FALLBACK;
  }, [kioskSettings.data]);

  const fleet: FleetRow[] = useMemo(() => {
    const byDevice = new Map<string, KioskHealthRow>();
    for (const row of healthToday.data ?? []) byDevice.set(row.kiosk_device_id, row);
    return asArray(devices.data).map((device) => {
      const quiet = device.last_seen_at === null ? null : minutesSince(device.last_seen_at);
      return {
        device,
        today: byDevice.get(device.id) ?? null,
        state: deviceState(device, quiet, offlineMinutes),
        minutesQuiet: quiet,
      };
    });
  }, [devices.data, healthToday.data, offlineMinutes]);

  // Fleet tiles: counts over the exact rows rendered below, never a re-derived
  // percentage. `reduce` on a count is not business arithmetic — it is the same
  // series the reader can add up by eye.
  const todayRows = healthToday.data ?? [];
  const attemptsToday = todayRows.reduce((sum, row) => sum + row.total_attempts, 0);
  const matchedToday = todayRows.reduce((sum, row) => sum + row.matched, 0);
  const worstLatency = todayRows.reduce<KioskHealthRow | null>((worst, row) => {
    if (row.p95_latency_ms === null) return worst;
    if (worst === null || worst.p95_latency_ms === null) return row;
    return row.p95_latency_ms > worst.p95_latency_ms ? row : worst;
  }, null);
  const activeCount = fleet.filter((r) => r.device.revoked_at === null && r.device.is_active).length;
  const revokedCount = fleet.length - activeCount;
  const reportingCount = fleet.filter((r) => r.state === "active" || r.state === "degraded").length;

  function setMonth(next: string): void {
    const nextParams = new URLSearchParams(params);
    nextParams.set("m", next);
    setParams(nextParams, { replace: false });
  }

  const fleetColumns: DataGridColumn<FleetRow>[] = [
    {
      key: "device",
      header: t("admin.kiosk.devices.col.device"),
      sortable: true,
      sortValue: (row) => row.device.device_code,
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
      render: (row) => {
        if (row.device.last_seen_at === null) return dash(null);
        return (
          <span className="flex flex-col leading-tight">
            <span className="num text-sm">{fmtDateTime(row.device.last_seen_at)}</span>
            {row.minutesQuiet !== null && row.minutesQuiet > offlineMinutes ? (
              <span className="text-xs text-warning">
                {t("admin.console.offlineFor", { minutes: formatNumber(row.minutesQuiet) })}
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: "skew",
      header: t("admin.kiosk.devices.col.skew"),
      align: "right",
      hideBelow: "lg",
      render: (row) => {
        const skew = row.device.clock_skew_seconds;
        if (skew === null) return dash(null);
        const flagged = Math.abs(skew) > CLOCK_SKEW_DEGRADED_SECONDS;
        return (
          <span className="flex flex-col items-end leading-tight">
            <span className={flagged ? "num text-warning" : "num"}>
              {t("admin.kiosk.devices.skewSeconds", { seconds: formatNumber(skew) })}
            </span>
            {flagged ? (
              <span className="text-xs text-warning">
                {t("admin.kiosk.devices.skewFlagged", { limit: CLOCK_SKEW_DEGRADED_SECONDS })}
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: "attempts",
      header: t("admin.kiosk.devices.col.attempts"),
      align: "right",
      width: "8rem",
      render: (row) =>
        row.today === null ? (
          <span className="text-xs text-muted-foreground">{t("admin.kiosk.devices.noScansToday")}</span>
        ) : (
          <span className="num">{formatNumber(row.today.total_attempts)}</span>
        ),
    },
    {
      key: "matchRate",
      header: t("admin.kiosk.devices.col.matchRate"),
      align: "right",
      width: "9rem",
      // The view's own clamped percentage. Never recomputed here (DR-27).
      render: (row) => dash(row.today?.match_success_pct ?? null, (v) => formatPercent(v)),
    },
    {
      key: "latency",
      header: t("admin.kiosk.devices.col.latency"),
      align: "right",
      hideBelow: "lg",
      render: (row) => {
        if (row.today === null) return dash(null);
        const p50 = row.today.p50_latency_ms;
        const p95 = row.today.p95_latency_ms;
        if (p50 === null && p95 === null) return dash(null);
        return (
          <span className="num">
            {t("admin.kiosk.devices.latencyPair", {
              p50: p50 === null ? dash(null) : formatNumber(p50),
              p95: p95 === null ? dash(null) : formatNumber(p95),
            })}
          </span>
        );
      },
    },
    {
      key: "threshold",
      header: t("admin.kiosk.devices.col.threshold"),
      align: "right",
      hideBelow: "md",
      render: (row) => (
        <ThresholdControl
          device={row.device}
          canEdit={isSuper}
          onSave={(value, reason) =>
            threshold.saveAsync({ deviceId: row.device.id, minMatchConfidence: value }, reason)
          }
        />
      ),
    },
    {
      key: "version",
      header: t("admin.kiosk.devices.col.version"),
      hideBelow: "lg",
      render: (row) => dash(row.device.app_version),
    },
    {
      key: "actions",
      header: t("admin.kiosk.devices.col.actions"),
      align: "right",
      width: "12rem",
      render: (row) => {
        /*
          TWO DIFFERENT GATES, because the two actions travel by different routes and
          the server does not treat them the same:

            * ISSUE PAIRING CODE goes through `kiosk-provision`, which checks the
              capability `kiosk.device.manage` — held by role `admin`, no step-up —
              and writes `secure.api_keys` with the service role, so RLS never
              applies. Any admin may do it.
            * REVOKE / RESTORE goes through PostgREST as the user (`updateKioskDevice`),
              so `kiosk_devices`'s super-admin-WRITE policy is the real gate.

          Both were hidden behind `isSuper`, which meant an admin who was fully
          authorised to hand out a pairing code was told "Super admin only" — the UI
          being stricter than the server, which reads as a broken product rather than
          a policy. Only the action RLS actually restricts is super-only now.
        */
        const canIssue = row.device.revoked_at === null;
        if (!canIssue && !isSuper) {
          return (
            <span className="text-xs text-muted-foreground">{t("admin.console.superOnly")}</span>
          );
        }
        return canIssue ? (
          <span className="inline-flex gap-2">
            <ReasonActionButton
              label={t("admin.kiosk.devices.action.issueCode")}
              variant="outline"
              title={t("admin.kiosk.devices.issue.title", { code: row.device.device_code })}
              description={t("admin.kiosk.devices.issue.description")}
              minLength={10}
              onConfirm={(reason) => issueCode.saveAsync(row.device.id, reason)}
            />
            {isSuper ? (
              <ReasonActionButton
                label={t("admin.kiosk.devices.action.revoke")}
                variant="outline"
                title={t("admin.kiosk.devices.revoke.title", { code: row.device.device_code })}
                description={t("admin.kiosk.devices.revoke.description", { label: row.device.label })}
                minLength={pairing.minReasonLength}
                onConfirm={(reason) =>
                  pairing.saveAsync({ deviceId: row.device.id, action: "revoke" }, reason)
                }
              />
            ) : null}
          </span>
        ) : (
          <ReasonActionButton
            label={t("admin.kiosk.devices.action.restore")}
            variant="outline"
            title={t("admin.kiosk.devices.restore.title", { code: row.device.device_code })}
            description={t("admin.kiosk.devices.restore.description")}
            minLength={pairing.minReasonLength}
            onConfirm={(reason) =>
              pairing.saveAsync({ deviceId: row.device.id, action: "restore" }, reason)
            }
          />
        );
      },
    },
  ];

  const monthColumns: DataGridColumn<KioskHealthRow>[] = [
    {
      key: "ist_date",
      header: t("admin.kiosk.devices.col.day"),
      width: "10rem",
      sortable: true,
      render: (row) => <span className="num">{fmtCivilDate(row.ist_date)}</span>,
    },
    {
      key: "device_code",
      header: t("admin.kiosk.devices.col.device"),
      sortable: true,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="font-mono text-xs">{row.device_code}</span>
          <span className="text-sm">{row.label}</span>
        </span>
      ),
    },
    {
      key: "total_attempts",
      header: t("admin.kiosk.devices.col.attempts"),
      align: "right",
      sortable: true,
      render: (row) => <span className="num">{formatNumber(row.total_attempts)}</span>,
    },
    {
      key: "outcomes",
      header: t("admin.kiosk.devices.col.outcomes"),
      hideBelow: "md",
      render: (row) => (
        <span className="text-xs text-muted-foreground">
          {t("admin.kiosk.devices.outcomes.summary", {
            matched: formatNumber(row.matched),
            noMatch: formatNumber(row.no_match),
            ambiguous: formatNumber(row.ambiguous),
            liveness: formatNumber(row.liveness_failures),
          })}
        </span>
      ),
    },
    {
      key: "match_success_pct",
      header: t("admin.kiosk.devices.col.matchRate"),
      align: "right",
      sortable: true,
      render: (row) => dash(row.match_success_pct, (v) => formatPercent(v)),
    },
    {
      key: "latency",
      header: t("admin.kiosk.devices.col.latency"),
      align: "right",
      hideBelow: "lg",
      render: (row) =>
        row.p50_latency_ms === null && row.p95_latency_ms === null ? (
          dash(null)
        ) : (
          <span className="num">
            {t("admin.kiosk.devices.latencyPair", {
              p50: row.p50_latency_ms === null ? dash(null) : formatNumber(row.p50_latency_ms),
              p95: row.p95_latency_ms === null ? dash(null) : formatNumber(row.p95_latency_ms),
            })}
          </span>
        ),
    },
    {
      key: "offline_replays",
      header: t("admin.kiosk.devices.col.replays"),
      align: "right",
      hideBelow: "lg",
      render: (row) => <span className="num">{formatNumber(row.offline_replays)}</span>,
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={ScanFace}
        title={t("admin.kiosk.devices.title")}
        subtitle={t("admin.kiosk.devices.subtitle")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/*
              ADD A DEVICE — the action that did not exist. `issue_activation_code`
              needs a device_id, so without this the fleet was permanently the one
              row a migration seeded and "Issue pairing code" could only re-pair it.

              No name is asked for, deliberately. Whoever pairs the device names it
              on the kiosk screen, which is the client's requirement and also the
              only moment anybody knows which phone it is going to be.

              NOT super-admin-gated. `kiosk-provision` checks `kiosk.device.manage`,
              which role `admin` holds with no step-up, and the INSERT runs with the
              service role inside the function — so RLS's super-admin-WRITE policy on
              `kiosk_devices` is not what decides this. Hiding it from admins would
              make the UI stricter than the server for no reason, and the client has
              been explicit that an admin can control everything.

              Outside `StateBoundary` on purpose: this copy keeps working when the
              device list itself fails to load.
            */}
            <AddDeviceButton onConfirm={(reason) => addDevice.saveAsync({}, reason)} />
            <MonthStepper month={month} onChange={setMonth} />
          </div>
        }
      />

      <KioskSectionNav />

      {/* First thing on the screen after the header: the link is the step that was
          missing, and it is what an admin comes here to hand over. */}
      <KioskLinkCard />

      {/*
        ONE code panel for BOTH actions. Adding a device and re-issuing a code both
        end with "read these six digits to somebody", and two separate panels could
        sit on screen at once showing two live codes — which is exactly the confusion
        that makes an admin read out the wrong one. The newer result wins.
      */}
      {pairingCode !== undefined ? (
        <div className="mt-4 rounded-lg border border-warning/50 bg-warning/10 p-4">
          <p className="text-sm font-medium">
            {t("admin.kiosk.devices.issue.result", {
              device: pairingCode.deviceCode,
              minutes: String(pairingCode.ttlMinutes),
            })}
          </p>
          <p className="num mt-2 font-display text-4xl tracking-[0.3em]">
            {pairingCode.activationCode}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("admin.kiosk.devices.issue.once")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("admin.kiosk.devices.issue.nameLater")}
          </p>
        </div>
      ) : null}
      {issueCode.userMessage !== null ? (
        <div className="mt-4">
          <Notice tone="error">{issueCode.userMessage}</Notice>
        </div>
      ) : null}
      {addDevice.userMessage !== null ? (
        <div className="mt-4">
          <Notice tone="error">{addDevice.userMessage}</Notice>
        </div>
      ) : null}

      {!isSuper ? (
        <p
          className="mb-4 flex items-start gap-2 rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground"
          role="status"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {t("admin.kiosk.devices.superOnlyHint")}
        </p>
      ) : null}

      <StateBoundary
        loading={devices.isLoading}
        error={devices.error ?? undefined}
        onRetry={() => void devices.refetch()}
        partialError={healthToday.error ?? kioskSettings.error ?? undefined}
        partialLabel={t("admin.kiosk.devices.col.matchRate")}
        isEmpty={devices.isSuccess && fleet.length === 0}
        empty={
          <EmptyState
            icon={TabletSmartphone}
            title={t("admin.kiosk.devices.empty.title")}
            hint={t("admin.kiosk.devices.empty.hint")}
            /*
              THE EMPTY STATE CARRIES THE ACTION, and this is not decoration.
              `StateBoundary` REPLACES its children with this node, so the + button
              that sits above the table is gone precisely when the fleet is empty —
              the one moment somebody definitely needs to add a device. A screen that
              says "no devices" with no way to add one is the same defect as a link on
              an unreachable page, just further along.
            */
            action={<AddDeviceButton onConfirm={(reason) => addDevice.saveAsync({}, reason)} />}
          />
        }
        skeletonRows={5}
      >
        <section className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <KpiTile
            label={t("admin.kiosk.devices.kpi.fleet")}
            value={formatNumber(fleet.length)}
            hint={t("admin.kiosk.devices.kpi.fleetHint", {
              active: formatNumber(activeCount),
              revoked: formatNumber(revokedCount),
            })}
          />
          <KpiTile
            label={t("admin.kiosk.devices.kpi.reporting")}
            value={formatNumber(reportingCount)}
            tone={reportingCount === activeCount ? "success" : "warn"}
            hint={t("admin.kiosk.devices.kpi.reportingHint", {
              minutes: formatNumber(offlineMinutes),
            })}
          />
          <KpiTile
            label={t("admin.kiosk.devices.kpi.attempts")}
            value={formatNumber(attemptsToday)}
            explainer={{
              formula: t("admin.kiosk.devices.kpi.attemptsFormula"),
              numbers: t("admin.kiosk.devices.kpi.attemptsNumbers", {
                total: formatNumber(attemptsToday),
                devices: formatNumber(todayRows.length),
              }),
            }}
          />
          <KpiTile
            label={t("admin.kiosk.devices.kpi.matched")}
            value={formatNumber(matchedToday)}
            explainer={{
              formula: t("admin.kiosk.devices.kpi.matchedFormula"),
              numbers: t("admin.kiosk.devices.kpi.matchedNumbers", {
                matched: formatNumber(matchedToday),
                total: formatNumber(attemptsToday),
              }),
            }}
          />
          <KpiTile
            label={t("admin.kiosk.devices.kpi.latency")}
            value={
              worstLatency?.p95_latency_ms == null
                ? dash(null)
                : t("admin.settings.health.jobs.ms", {
                    ms: formatNumber(worstLatency.p95_latency_ms),
                  })
            }
            explainer={{
              formula: t("admin.kiosk.devices.kpi.latencyFormula"),
              numbers:
                worstLatency?.p95_latency_ms == null
                  ? t("admin.kiosk.devices.noScansToday")
                  : t("admin.kiosk.devices.kpi.latencyNumbers", {
                      device: worstLatency.device_code,
                      value: t("admin.settings.health.jobs.ms", {
                        ms: formatNumber(worstLatency.p95_latency_ms),
                      }),
                    }),
            }}
          />
        </section>

        {/*
          THE + SITS WITH THE LIST IT ADDS TO.

          It is also in the page header, but the header scrolls away: on this screen
          the tiles and the grid push it off-screen, and an action you cannot see is
          an action that does not exist — the same mistake as putting the gate link
          on a page with no way in. A row immediately above the table stays next to
          the thing it changes.
        */}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-lg font-semibold">
            {t("admin.kiosk.devices.fleet.title")}
          </h2>
          <AddDeviceButton onConfirm={(reason) => addDevice.saveAsync({}, reason)} />
        </div>

        <DataGrid
          columns={fleetColumns}
          rows={fleet}
          rowKey={(row) => row.device.id}
          pageSize={25}
        />

        <p className="mt-3 flex items-start gap-2 rounded-md border bg-card px-3 py-2 text-xs text-muted-foreground">
          <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            <strong className="font-medium text-foreground">
              {t("admin.kiosk.devices.pairing.title")}
            </strong>{" "}
            {t("admin.kiosk.devices.pairing.hint")}
          </span>
        </p>
      </StateBoundary>

      <h2 className="mb-3 mt-8 font-display text-lg font-semibold">
        {t("admin.kiosk.devices.health.title")}
      </h2>

      <StateBoundary
        loading={healthMonth.isLoading}
        error={healthMonth.error ?? undefined}
        onRetry={() => void healthMonth.refetch()}
        skeletonRows={4}
      >
        <DataGrid
          columns={monthColumns}
          rows={healthMonth.data ?? []}
          rowKey={(row) => `${row.kiosk_device_id}:${row.ist_date}`}
          pageSize={31}
          emptyState={
            <EmptyState
              icon={ScanFace}
              title={t("admin.kiosk.devices.health.empty.title", { month: fmtMonthLong(month) })}
              hint={t("admin.kiosk.devices.health.empty.hint")}
              action={
                <Button variant="outline" asChild>
                  <Link to="/admin/kiosk/match-review">{t("admin.kiosk.match.title")}</Link>
                </Button>
              }
            />
          }
        />
      </StateBoundary>
    </div>
  );
}

/**
 * The accept threshold, inline. A threshold change is the single most
 * consequential kiosk edit — it changes who the gate lets through without a
 * guard — so it is super-admin only and never carries a default reason (§5.9).
 */
function ThresholdControl({
  device,
  canEdit,
  onSave,
}: {
  device: KioskDevice;
  canEdit: boolean;
  onSave: (value: number, reason: string) => Promise<unknown>;
}) {
  const current = device.min_match_confidence;
  const [draft, setDraft] = useState(() => (current === null ? "" : String(current)));
  const [editing, setEditing] = useState(false);

  const parsed = Number(draft.trim());
  const valid =
    draft.trim() !== "" &&
    Number.isFinite(parsed) &&
    parsed >= THRESHOLD_MIN &&
    parsed <= THRESHOLD_MAX;

  if (!editing) {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="num">{dash(current, (v) => v.toFixed(2))}</span>
        {canEdit ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(current === null ? "" : String(current));
              setEditing(true);
            }}
          >
            {t("admin.settings.row.edit")}
          </Button>
        ) : null}
      </span>
    );
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Input
        value={draft}
        inputMode="decimal"
        aria-label={t("admin.kiosk.devices.threshold.label")}
        aria-invalid={!valid}
        onChange={(e) => setDraft(e.target.value)}
        className="h-8 w-24 text-right"
      />
      {!valid ? (
        <span className="text-xs font-medium text-destructive" role="alert">
          {t("admin.kiosk.devices.threshold.invalid")}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">{t("admin.kiosk.devices.threshold.hint")}</span>
      )}
      <span className="flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
          {t("admin.settings.row.cancel")}
        </Button>
        <ReasonActionButton
          label={t("admin.settings.row.save")}
          variant="default"
          disabled={!valid}
          disabledHint={t("admin.kiosk.devices.threshold.invalid")}
          title={t("admin.kiosk.devices.threshold.title", { code: device.device_code })}
          description={t("admin.kiosk.devices.threshold.description", {
            current: dash(current, (v) => v.toFixed(2)),
            next: valid ? parsed.toFixed(2) : draft.trim(),
          })}
          onConfirm={async (reason) => {
            await onSave(parsed, reason);
            setEditing(false);
          }}
        />
      </span>
    </span>
  );
}
