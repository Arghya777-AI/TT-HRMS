/**
 * E-18.1 · /me/settings/notifications — channel preferences, honestly bounded.
 *
 * `public.notification_preferences` IS modelled and IS self-writable: RLS gives
 * the signed-in profile select/insert/update on its own `(event_code, channel)`
 * rows. So every row this screen shows is editable for real, and the toggle
 * writes to the table.
 *
 * What does NOT exist for an employee is the CATALOGUE. `notification_templates`
 * — the 58 seeded rows that name every event code and, crucially, carry
 * `is_transactional` — is admin-only (P8). Verified live: 58 rows as the HR
 * admin, 0 as an employee. Two consequences the screen states rather than papers
 * over:
 *
 *   1. It cannot offer "here is every notice you could switch off", because the
 *      list of event codes is not readable by the person whose preferences they
 *      are. It edits the rows that exist.
 *   2. It cannot tell you WHICH notices ignore preferences. 56 of the 58 seeded
 *      templates are transactional (salary credited, no-show alert, approval
 *      overdue) and the dispatcher skips preferences for those by design — but
 *      `is_transactional` is invisible here, so the screen says the rule instead
 *      of labelling individual rows with a flag it cannot read.
 *
 * The one thing it CAN show from real data is what has actually reached you: a
 * per-channel `count=exact` over your own notifications. That is a server count
 * per channel, not a client tally.
 *
 * @route /me/settings/notifications
 */
import { useMemo } from "react";
import { Bell, Cog, Inbox, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { KpiTile } from "@/shared/ui/KpiTile";
import { Notice } from "@/features/admin/components/Notice";
import { fmtCivilTime, fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import {
  notificationChannelValues,
  type NotificationChannel,
} from "@/features/notifications/api/notifications.api";
import {
  digestFrequencySchema,
  type DigestFrequency,
  type NotificationPreference,
} from "../api/settings.api";
import {
  useMyChannelCounts,
  useMyNotificationPreferences,
  useSetPreferenceDigest,
  useSetPreferenceEnabled,
} from "../hooks/useMeSettings";

const CHANNEL_LABEL: Readonly<Record<NotificationChannel, string>> = {
  in_app: t("notif.channel.inApp"),
  email: t("notif.channel.email"),
  sms: t("notif.channel.sms"),
  whatsapp: t("notif.channel.whatsapp"),
  push: t("notif.channel.push"),
  kiosk_display: t("notif.channel.kiosk"),
};

const DIGEST_LABEL: Readonly<Record<DigestFrequency, string>> = {
  immediate: t("settings.notif.digest.immediate"),
  hourly: t("settings.notif.digest.hourly"),
  daily: t("settings.notif.digest.daily"),
  weekly: t("settings.notif.digest.weekly"),
  off: t("settings.notif.digest.off"),
};

function humaniseEventCode(code: string): string {
  const words = code.replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export default function NotificationPreferencesPage() {
  const prefs = useMyNotificationPreferences();
  const counts = useMyChannelCounts();
  const setEnabled = useSetPreferenceEnabled();
  const setDigest = useSetPreferenceDigest();

  const rows = prefs.data ?? [];
  const busy = setEnabled.isPending || setDigest.isPending;

  const usedChannels = useMemo(
    () => notificationChannelValues.filter((channel) => (counts.data?.[channel] ?? 0) > 0),
    [counts.data],
  );

  const columns: DataGridColumn<NotificationPreference>[] = [
    {
      key: "event_code",
      header: t("settings.notif.col.event"),
      render: (row) => (
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">{humaniseEventCode(row.event_code)}</span>
          <span className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
            {row.event_code}
          </span>
        </span>
      ),
    },
    {
      key: "channel",
      header: t("settings.notif.col.channel"),
      width: "9rem",
      render: (row) => dash(CHANNEL_LABEL[row.channel]),
    },
    {
      key: "is_enabled",
      header: t("settings.notif.col.enabled"),
      width: "9rem",
      render: (row) => (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 rounded border-input"
            checked={row.is_enabled}
            disabled={busy}
            onChange={(event) =>
              setEnabled.mutate({ id: row.id, isEnabled: event.target.checked })
            }
          />
          <span>{row.is_enabled ? t("settings.notif.on") : t("settings.notif.off")}</span>
        </label>
      ),
    },
    {
      key: "digest_frequency",
      header: t("settings.notif.col.digest"),
      width: "11rem",
      render: (row) => (
        <select
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          value={row.digest_frequency}
          disabled={busy}
          onChange={(event) => {
            const parsed = digestFrequencySchema.safeParse(event.target.value);
            if (parsed.success) setDigest.mutate({ id: row.id, digest: parsed.data });
          }}
          aria-label={t("settings.notif.col.digest")}
        >
          {digestFrequencySchema.options.map((option) => (
            <option key={option} value={option}>
              {DIGEST_LABEL[option]}
            </option>
          ))}
        </select>
      ),
    },
    {
      key: "quiet_hours",
      header: t("settings.notif.col.quiet"),
      width: "11rem",
      hideBelow: "lg",
      render: (row) =>
        row.quiet_hours_start !== null && row.quiet_hours_end !== null ? (
          <span className="num">
            {fmtCivilTime(row.quiet_hours_start)} – {fmtCivilTime(row.quiet_hours_end)}
          </span>
        ) : (
          <span className="text-muted-foreground">{t("settings.notif.quiet.none")}</span>
        ),
    },
    {
      key: "updated_at",
      header: t("settings.notif.col.updated"),
      width: "11rem",
      hideBelow: "lg",
      render: (row) => <span className="num text-xs">{fmtDateTime(row.updated_at)}</span>,
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={Cog}
        title={t("settings.notif.title")}
        subtitle={t("settings.notif.subtitle")}
      />

      <Notice tone="info">{t("settings.notif.statutory")}</Notice>

      {setEnabled.isError || setDigest.isError ? (
        <Notice tone="error" className="mt-3">
          {t("settings.notif.saveFailed")}
        </Notice>
      ) : null}

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">{t("settings.notif.rows.title")}</CardTitle>
          <CardDescription>{t("settings.notif.rows.hint")}</CardDescription>
        </CardHeader>
        <CardContent>
          <StateBoundary
            loading={prefs.isPending}
            error={prefs.error}
            onRetry={() => void prefs.refetch()}
            isEmpty={rows.length === 0}
            skeletonRows={3}
            empty={
              <EmptyState
                icon={ShieldCheck}
                title={t("settings.notif.empty.title")}
                hint={t("settings.notif.empty.hint")}
              />
            }
          >
            <DataGrid columns={columns} rows={rows} rowKey={(row) => row.id} pageSize={25} />
          </StateBoundary>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">{t("settings.notif.delivered.title")}</CardTitle>
          <CardDescription>{t("settings.notif.delivered.hint")}</CardDescription>
        </CardHeader>
        <CardContent>
          <StateBoundary
            loading={counts.isPending}
            error={counts.error}
            onRetry={() => void counts.refetch()}
            isEmpty={usedChannels.length === 0}
            skeletonRows={2}
            empty={
              <EmptyState
                icon={Inbox}
                title={t("settings.notif.delivered.empty.title")}
                hint={t("settings.notif.delivered.empty.hint")}
              />
            }
          >
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {usedChannels.map((channel) => (
                <KpiTile
                  key={channel}
                  label={CHANNEL_LABEL[channel]}
                  value={formatNumber(counts.data?.[channel] ?? 0)}
                  tone="info"
                  hint={t("settings.notif.delivered.tileHint")}
                  to="/me/notifications"
                  drillLabel={t("settings.notif.delivered.drill", {
                    channel: CHANNEL_LABEL[channel],
                  })}
                  explainer={{
                    formula: t("settings.notif.delivered.formula"),
                    numbers: t("settings.notif.delivered.numbers", {
                      n: formatNumber(counts.data?.[channel] ?? 0),
                      channel: CHANNEL_LABEL[channel],
                    }),
                  }}
                />
              ))}
            </div>
          </StateBoundary>
        </CardContent>
      </Card>

      <p className="mt-4 flex items-start gap-2 text-xs text-muted-foreground">
        <Bell className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{t("settings.notif.footnote")}</span>
      </p>
    </div>
  );
}
