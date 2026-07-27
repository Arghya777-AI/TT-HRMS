/**
 * A-KIOSK-08 · /admin/kiosk/policy — the matching, liveness and duplicate policy
 * the gate reads (spec-admin §5.9 threshold governance).
 *
 * Everything on this screen is a `public.settings` row of group `kiosk` (seeded
 * by migration 046) or a column on `public.kiosk_devices`. That matters twice:
 *
 *  1. WHO MAY CHANGE WHAT IS DATA, NOT A GUESS. `settings__admin_write` allows an
 *     admin only where `is_editable_by_admin` is true, and the three rows that
 *     decide who the gate lets in — `kiosk.min_confidence`, `kiosk.min_margin`,
 *     `kiosk.require_liveness` — are seeded `false`. `SettingRow` therefore locks
 *     them for an admin and says why, instead of letting a reason be typed and
 *     then meeting a 42501. The table is reason-required, so every change carries
 *     a sentence into the audit chain.
 *  2. A DEVICE CAN BE LOOSER THAN THE COMPANY. `kiosk_devices.min_match_confidence`
 *     is the floor that gate actually applies (default 0.62). A tablet sitting
 *     BELOW the company floor accepts faces the policy wanted a guard to look at,
 *     so the per-gate table names that state rather than printing two numbers side
 *     by side and hoping somebody compares them. Device writes are super-admin and
 *     live on `/admin/kiosk/devices`; this screen links there rather than growing a
 *     second write path to the same column.
 *
 * Two honest limitations, on the screen as well as here:
 *   * There is no per-employee threshold override in this build. spec-admin §5.9
 *     describes `employee.face_accept_threshold` bounded to [0.40, 0.58]; no such
 *     column exists in migration 008, so the screen does not offer one.
 *   * A threshold change is supposed to leave a marker on the kiosk analytics
 *     chart. The audit row is written (the table is reason-required); the chart
 *     annotation is not part of `v_kiosk_health`, so this screen points at the
 *     audit trail for the history instead of claiming a marker exists.
 *
 * @route /admin/kiosk/policy
 */
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Cog, ScanFace, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { asArray } from "@/lib/asArray";
import { Badge } from "@/components/ui/badge";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { dash, formatNumber } from "@/lib/format";
import { t, type MessageKey } from "@/shared/i18n/en";
import { useAuth } from "@/app/auth/AuthProvider";
import {
  KIOSK_SETTING_KEYS,
  deviceFloorState,
  findSetting,
  settingBoolean,
  settingNumber,
  type DeviceFloorState,
} from "../api/kiosk-governance.api";
import type { KioskDevice, Setting } from "../api/system.api";
import { useKioskDevices } from "../hooks/useKioskConsole";
import { useSettingMutation, useSettingsGroup } from "../hooks/useSettingsConsole";
import { Notice } from "../components/Notice";
import { SettingRow } from "../components/SettingRow";
import { KioskSectionNav } from "../components/KioskSectionNav";

/** `settings.group_name` for every row on this screen. */
const KIOSK_GROUP = "kiosk";

interface PolicySection {
  readonly titleKey: MessageKey;
  readonly hintKey: MessageKey;
  readonly keys: readonly string[];
}

/**
 * The reading order of the policy, not the seed's alphabetical order: what
 * decides an identity first, then what proves the face is present, then what the
 * gate does with a repeat scan, then the fleet's operational limits, then how
 * long the evidence is kept.
 */
const SECTIONS: readonly PolicySection[] = [
  {
    titleKey: "admin.kiosk.policy.section.matching",
    hintKey: "admin.kiosk.policy.section.matchingHint",
    keys: [KIOSK_SETTING_KEYS.minConfidence, KIOSK_SETTING_KEYS.minMargin],
  },
  {
    titleKey: "admin.kiosk.policy.section.liveness",
    hintKey: "admin.kiosk.policy.section.livenessHint",
    keys: [KIOSK_SETTING_KEYS.requireLiveness],
  },
  {
    titleKey: "admin.kiosk.policy.section.duplicates",
    hintKey: "admin.kiosk.policy.section.duplicatesHint",
    keys: [KIOSK_SETTING_KEYS.debounceSeconds],
  },
  {
    titleKey: "admin.kiosk.policy.section.fleet",
    hintKey: "admin.kiosk.policy.section.fleetHint",
    keys: [
      KIOSK_SETTING_KEYS.offlineQueueMax,
      KIOSK_SETTING_KEYS.heartbeatSeconds,
      KIOSK_SETTING_KEYS.offlineAlertMinutes,
    ],
  },
  {
    titleKey: "admin.kiosk.policy.section.evidence",
    hintKey: "admin.kiosk.policy.section.evidenceHint",
    keys: [KIOSK_SETTING_KEYS.photoRetentionDays, KIOSK_SETTING_KEYS.photoUrlTtlSeconds],
  },
];

const FLOOR_CHIP: Readonly<Record<DeviceFloorState, StatusChipEntry>> = {
  matches: { label: t("admin.kiosk.policy.floor.matches"), tone: "success" },
  stricter: { label: t("admin.kiosk.policy.floor.stricter"), tone: "info" },
  looser: { label: t("admin.kiosk.policy.floor.looser"), tone: "danger" },
  unset: { label: t("admin.kiosk.policy.floor.unset"), tone: "warn" },
  unknown: { label: t("admin.kiosk.policy.floor.unknown"), tone: "neutral" },
};

export default function KioskPolicyPage() {
  const { can } = useAuth();
  const isSuper = can("admin.super");

  const settings = useSettingsGroup(KIOSK_GROUP);
  const devices = useKioskDevices();
  const save = useSettingMutation();

  // Memoised because the `unsectioned` list depends on it: `?? []` alone would
  // hand `useMemo` a fresh array on every render and re-filter nine rows forever.
  const rows = useMemo(() => settings.data ?? [], [settings.data]);
  const minConfidence = settingNumber(rows, KIOSK_SETTING_KEYS.minConfidence);
  const minMargin = settingNumber(rows, KIOSK_SETTING_KEYS.minMargin);
  const requireLiveness = settingBoolean(rows, KIOSK_SETTING_KEYS.requireLiveness);
  const debounceSeconds = settingNumber(rows, KIOSK_SETTING_KEYS.debounceSeconds);

  /** Rows the sections do not name — shown rather than silently dropped. */
  const unsectioned = useMemo(() => {
    const claimed = new Set(SECTIONS.flatMap((section) => section.keys));
    return rows.filter((row) => !claimed.has(row.key));
  }, [rows]);

  function canEdit(setting: Setting): boolean {
    return isSuper || setting.is_editable_by_admin;
  }

  const deviceColumns: DataGridColumn<KioskDevice>[] = [
    {
      key: "device",
      header: t("admin.kiosk.policy.col.device"),
      sortable: true,
      sortValue: (row) => row.device_code,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="font-mono text-xs">{row.device_code}</span>
          <span className="text-sm">{row.label}</span>
        </span>
      ),
    },
    {
      key: "min_match_confidence",
      header: t("admin.kiosk.policy.col.floor"),
      align: "right",
      width: "8rem",
      sortable: true,
      render: (row) => dash(row.min_match_confidence, (v) => v.toFixed(2)),
    },
    {
      key: "floorState",
      header: t("admin.kiosk.policy.col.against"),
      width: "13rem",
      render: (row) => {
        const state = deviceFloorState(row, minConfidence);
        return <StatusChip status={state} map={{ [state]: FLOOR_CHIP[state] }} />;
      },
    },
    {
      key: "require_operator",
      header: t("admin.kiosk.policy.col.operator"),
      width: "11rem",
      hideBelow: "md",
      render: (row) =>
        row.require_operator ? (
          <Badge variant="success">{t("admin.kiosk.policy.operator.required")}</Badge>
        ) : (
          <Badge variant="warning">{t("admin.kiosk.policy.operator.unattended")}</Badge>
        ),
    },
    {
      key: "max_offline_queue",
      header: t("admin.kiosk.policy.col.queue"),
      align: "right",
      hideBelow: "lg",
      render: (row) => dash(row.max_offline_queue, formatNumber),
    },
    {
      key: "state",
      header: t("admin.kiosk.policy.col.state"),
      width: "9rem",
      hideBelow: "lg",
      render: (row) =>
        row.revoked_at !== null || !row.is_active ? (
          <Badge variant="neutral">{t("admin.kiosk.policy.device.revoked")}</Badge>
        ) : (
          <Badge variant="success">{t("admin.kiosk.policy.device.live")}</Badge>
        ),
    },
  ];

  const looseDevices = asArray(devices.data).filter(
    (device) => deviceFloorState(device, minConfidence) === "looser",
  );

  return (
    <div className="container py-6">
      <PageHeader
        icon={Cog}
        title={t("admin.kiosk.policy.title")}
        subtitle={t("admin.kiosk.policy.subtitle")}
        actions={
          <Button variant="outline" asChild>
            <Link to="/admin/kiosk/match-review">{t("admin.kiosk.policy.action.matchReview")}</Link>
          </Button>
        }
      />

      <KioskSectionNav />

      <Notice tone="warning">{t("admin.kiosk.policy.governance")}</Notice>

      {!isSuper ? (
        <p
          className="mt-3 flex items-start gap-2 rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground"
          role="status"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {t("admin.kiosk.policy.adminHint")}
        </p>
      ) : null}

      <StateBoundary
        loading={settings.isLoading}
        error={settings.error ?? undefined}
        onRetry={() => void settings.refetch()}
        isEmpty={settings.isSuccess && rows.length === 0}
        empty={
          <EmptyState
            icon={Cog}
            title={t("admin.kiosk.policy.empty.title")}
            hint={t("admin.kiosk.policy.empty.hint")}
          />
        }
        skeletonRows={5}
      >
        <section className="mb-6 mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <KpiTile
            label={t("admin.kiosk.policy.kpi.confidence")}
            value={dash(minConfidence, (v) => v.toFixed(2))}
            hint={t("admin.kiosk.policy.kpi.confidenceHint")}
          />
          <KpiTile
            label={t("admin.kiosk.policy.kpi.margin")}
            value={dash(minMargin, (v) => v.toFixed(2))}
            hint={t("admin.kiosk.policy.kpi.marginHint")}
          />
          <KpiTile
            label={t("admin.kiosk.policy.kpi.liveness")}
            value={
              requireLiveness === null
                ? dash(null)
                : requireLiveness
                  ? t("admin.kiosk.policy.kpi.livenessOn")
                  : t("admin.kiosk.policy.kpi.livenessOff")
            }
            tone={requireLiveness === true ? "success" : "warn"}
            hint={t("admin.kiosk.policy.kpi.livenessHint")}
          />
          <KpiTile
            label={t("admin.kiosk.policy.kpi.debounce")}
            value={dash(debounceSeconds, (v) => t("admin.kiosk.policy.seconds", { n: formatNumber(v) }))}
            hint={t("admin.kiosk.policy.kpi.debounceHint")}
          />
        </section>

        {/*
          The decision rule in words, with the live numbers in it. Sourced from
          the deployed pieces: `v_face_match_audit` records `best_confidence`,
          `margin` (runner-up minus best) and the `threshold_used` pinned at the
          moment of the scan, and `void-punch` files a duplicate as `debounce`.
        */}
        <section className="mb-8 rounded-lg border bg-card p-4">
          <h2 className="font-display text-lg font-semibold">
            {t("admin.kiosk.policy.rule.title")}
          </h2>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
            <li>
              {t("admin.kiosk.policy.rule.accept", {
                confidence: dash(minConfidence, (v) => v.toFixed(2)),
                margin: dash(minMargin, (v) => v.toFixed(2)),
              })}
            </li>
            <li>{t("admin.kiosk.policy.rule.ambiguous")}</li>
            <li>
              {requireLiveness === false
                ? t("admin.kiosk.policy.rule.livenessOff")
                : t("admin.kiosk.policy.rule.livenessOn")}
            </li>
            <li>
              {t("admin.kiosk.policy.rule.debounce", {
                seconds: dash(debounceSeconds, formatNumber),
              })}
            </li>
            <li>{t("admin.kiosk.policy.rule.history")}</li>
          </ol>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" asChild>
              <Link to="/admin/kiosk/abuse">{t("admin.kiosk.abuse.title")}</Link>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/admin/analytics/kiosk">{t("admin.kiosk.policy.action.analytics")}</Link>
            </Button>
          </div>
        </section>

        {save.userMessage !== null ? (
          <div className="mb-4">
            <Notice tone="error">{save.userMessage}</Notice>
          </div>
        ) : null}

        {SECTIONS.map((section) => {
          const sectionRows = section.keys
            .map((key) => findSetting(rows, key))
            .filter((row): row is Setting => row !== null);
          if (sectionRows.length === 0) return null;
          return (
            <section key={section.titleKey} className="mb-6">
              <h2 className="font-display text-lg font-semibold">{t(section.titleKey)}</h2>
              <p className="mb-3 mt-1 text-sm text-muted-foreground">{t(section.hintKey)}</p>
              <div className="rounded-lg border bg-card">
                {sectionRows.map((setting) => (
                  <SettingRow
                    key={setting.key}
                    setting={setting}
                    canEdit={canEdit(setting)}
                    onSave={(value, reason) =>
                      save.saveAsync({ key: setting.key, value, groupName: KIOSK_GROUP }, reason)
                    }
                  />
                ))}
              </div>
            </section>
          );
        })}

        {unsectioned.length > 0 ? (
          <section className="mb-6">
            <h2 className="font-display text-lg font-semibold">
              {t("admin.kiosk.policy.section.other")}
            </h2>
            <p className="mb-3 mt-1 text-sm text-muted-foreground">
              {t("admin.kiosk.policy.section.otherHint")}
            </p>
            <div className="rounded-lg border bg-card">
              {unsectioned.map((setting) => (
                <SettingRow
                  key={setting.key}
                  setting={setting}
                  canEdit={canEdit(setting)}
                  onSave={(value, reason) =>
                    save.saveAsync({ key: setting.key, value, groupName: KIOSK_GROUP }, reason)
                  }
                />
              ))}
            </div>
          </section>
        ) : null}
      </StateBoundary>

      <h2 className="mb-1 mt-8 font-display text-lg font-semibold">
        {t("admin.kiosk.policy.devices.title")}
      </h2>
      <p className="mb-3 text-sm text-muted-foreground">{t("admin.kiosk.policy.devices.hint")}</p>

      {looseDevices.length > 0 ? (
        <div className="mb-3">
          <Notice tone="warning">
            {t("admin.kiosk.policy.devices.looseWarning", {
              count: formatNumber(looseDevices.length),
              codes: looseDevices.map((device) => device.device_code).join(", "),
              floor: dash(minConfidence, (v) => v.toFixed(2)),
            })}
          </Notice>
        </div>
      ) : null}

      <StateBoundary
        loading={devices.isLoading}
        error={devices.error ?? undefined}
        onRetry={() => void devices.refetch()}
        partialError={settings.error ?? undefined}
        partialLabel={t("admin.kiosk.policy.col.against")}
        skeletonRows={3}
      >
        <DataGrid
          columns={deviceColumns}
          rows={devices.data ?? []}
          rowKey={(row) => row.id}
          pageSize={25}
          emptyState={
            <EmptyState
              icon={ScanFace}
              title={t("admin.kiosk.policy.devices.empty.title")}
              hint={t("admin.kiosk.policy.devices.empty.hint")}
              action={
                <Button variant="outline" asChild>
                  <Link to="/admin/kiosk/devices">{t("admin.kiosk.devices.title")}</Link>
                </Button>
              }
            />
          }
        />
      </StateBoundary>

      <p className="mt-4 flex items-start gap-2 rounded-md border bg-card px-3 py-2 text-xs text-muted-foreground">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          <strong className="font-medium text-foreground">
            {t("admin.kiosk.policy.limits.title")}
          </strong>{" "}
          {t("admin.kiosk.policy.limits.hint")}
        </span>
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="ghost" asChild>
          <Link to="/admin/kiosk/devices">{t("admin.kiosk.devices.title")}</Link>
        </Button>
        <Button variant="ghost" asChild>
          <Link to="/admin/audit">{t("admin.kiosk.policy.action.audit")}</Link>
        </Button>
      </div>
    </div>
  );
}
