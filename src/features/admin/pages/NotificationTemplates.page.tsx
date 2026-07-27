/**
 * A-SET-04 · /admin/settings/notifications — the per-event, per-channel template
 * register (spec-admin §15.7).
 *
 * `notification_templates` is one row per event code × channel, admin FOR ALL.
 * What this screen governs is which channels are LIVE; rewriting the copy itself
 * is a versioned change with its own review and is not switched on, so the screen
 * says that rather than shipping a textarea whose history nobody keeps.
 *
 * `is_system` rows are the seeded catalogue. They can be silenced (an admin must
 * be able to stop a noisy reminder at 22:00) but the screen marks them, because
 * a silenced transactional template is a decision someone will have to explain.
 *
 * @route /admin/settings/notifications
 */
import { useMemo, useState } from "react";
import { Bell } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { NotificationTemplateRow } from "../api/health.api";
import {
  useNotificationTemplateMutation,
  useNotificationTemplates,
} from "../hooks/useSettingsConsole";
import { channelLabel } from "../kiosk-display";
import { ReasonActionButton } from "../components/ReasonActionButton";

export default function NotificationTemplatesPage() {
  const [channel, setChannel] = useState<string>("all");
  const templates = useNotificationTemplates();
  const toggle = useNotificationTemplateMutation();

  const rows = useMemo(() => templates.data ?? [], [templates.data]);
  const channels = useMemo(() => {
    const set = new Set<string>();
    for (const row of rows) set.add(row.channel);
    return [...set].sort((a, b) => a.localeCompare(b, "en-IN"));
  }, [rows]);

  const visible = useMemo(
    () => (channel === "all" ? rows : rows.filter((r) => r.channel === channel)),
    [rows, channel],
  );
  const silenced = rows.filter((r) => !r.is_active).length;

  const columns: DataGridColumn<NotificationTemplateRow>[] = [
    {
      key: "event",
      header: t("admin.settings.notif.col.event"),
      sortable: true,
      sortValue: (row) => row.code,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="text-sm font-medium">{row.name}</span>
          <span className="font-mono text-xs text-muted-foreground">{row.code}</span>
          {row.description !== null ? (
            <span className="mt-0.5 max-w-md text-xs text-muted-foreground">{row.description}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: "channel",
      header: t("admin.settings.notif.col.channel"),
      width: "9rem",
      render: (row) => (
        <span className="flex flex-col items-start gap-1 leading-tight">
          <span className="text-sm">{channelLabel(row.channel)}</span>
          {row.dlt_template_id !== null ? (
            <span className="font-mono text-xs text-muted-foreground">
              {t("admin.settings.notif.dlt", { id: row.dlt_template_id })}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "subject",
      header: t("admin.settings.notif.col.subject"),
      hideBelow: "md",
      render: (row) => (
        <span className="block max-w-md break-words text-xs text-muted-foreground">
          {dash(row.subject_template ?? row.sms_template)}
        </span>
      ),
    },
    {
      key: "locale",
      header: t("admin.settings.notif.col.locale"),
      width: "7rem",
      hideBelow: "lg",
      render: (row) => <span className="font-mono text-xs">{row.locale}</span>,
    },
    {
      key: "state",
      header: t("admin.settings.notif.col.state"),
      width: "12rem",
      render: (row) => (
        <span className="flex flex-wrap items-center gap-1">
          <StatusChip
            status={row.is_active ? "active" : "inactive"}
            map={{
              active: { label: t("admin.settings.notif.state.active"), tone: "success" },
              inactive: { label: t("admin.settings.notif.state.inactive"), tone: "neutral" },
            }}
          />
          {row.is_transactional ? (
            <Badge variant="info">{t("admin.settings.notif.transactional")}</Badge>
          ) : null}
          {row.is_system ? <Badge variant="outline">{t("admin.settings.notif.seeded")}</Badge> : null}
        </span>
      ),
    },
    {
      key: "actions",
      header: t("admin.settings.notif.col.actions"),
      align: "right",
      width: "10rem",
      render: (row) =>
        row.is_active ? (
          <ReasonActionButton
            label={t("admin.settings.notif.action.disable")}
            title={t("admin.settings.notif.disable.title", { name: row.name })}
            description={t("admin.settings.notif.disable.description")}
            onConfirm={async (reason) => {
              await toggle.saveAsync({ id: row.id, isActive: false }, reason);
              toast.success(t("admin.settings.notif.saved", { name: row.name }));
            }}
          />
        ) : (
          <ReasonActionButton
            label={t("admin.settings.notif.action.enable")}
            variant="default"
            title={t("admin.settings.notif.enable.title", { name: row.name })}
            description={t("admin.settings.notif.enable.description")}
            onConfirm={async (reason) => {
              await toggle.saveAsync({ id: row.id, isActive: true }, reason);
              toast.success(t("admin.settings.notif.saved", { name: row.name }));
            }}
          />
        ),
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={Bell}
        title={t("admin.settings.notif.title")}
        subtitle={t("admin.settings.notif.subtitle")}
      />

      <StateBoundary
        loading={templates.isLoading}
        error={templates.error ?? undefined}
        onRetry={() => void templates.refetch()}
        isEmpty={templates.isSuccess && rows.length === 0}
        empty={
          <EmptyState
            icon={Bell}
            title={t("admin.settings.notif.empty.title")}
            hint={t("admin.settings.notif.empty.hint")}
          />
        }
        skeletonRows={5}
      >
        <section className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <KpiTile label={t("admin.settings.notif.kpi.total")} value={formatNumber(rows.length)} />
          <KpiTile
            label={t("admin.settings.notif.kpi.silenced")}
            value={formatNumber(silenced)}
            tone={silenced > 0 ? "warn" : "success"}
          />
          <KpiTile
            label={t("admin.settings.notif.kpi.channels")}
            value={formatNumber(channels.length)}
          />
        </section>

        <DataGrid
          columns={columns}
          rows={visible}
          rowKey={(row) => row.id}
          pageSize={25}
          toolbar={
            <div className="flex flex-wrap gap-1" role="group">
              <Button
                size="sm"
                variant={channel === "all" ? "default" : "outline"}
                aria-pressed={channel === "all"}
                onClick={() => setChannel("all")}
              >
                {t("admin.settings.notif.filter.all")}
              </Button>
              {channels.map((c) => (
                <Button
                  key={c}
                  size="sm"
                  variant={channel === c ? "default" : "outline"}
                  aria-pressed={channel === c}
                  onClick={() => setChannel(c)}
                >
                  {channelLabel(c)}
                </Button>
              ))}
            </div>
          }
          emptyState={
            <EmptyState
              icon={Bell}
              title={t("admin.settings.notif.empty.title")}
              hint={t("admin.settings.notif.empty.hint")}
              action={
                <Button variant="outline" onClick={() => setChannel("all")}>
                  {t("admin.settings.notif.filter.all")}
                </Button>
              }
            />
          }
        />

        <p className="mt-3 text-xs text-muted-foreground">{t("admin.settings.notif.copyNote")}</p>
      </StateBoundary>
    </div>
  );
}
