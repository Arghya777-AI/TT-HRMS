/**
 * E-16 · /me/notifications — everything the system has told me, newest first.
 *
 * The feed is REAL and already moving on the live project: the cron jobs write
 * KIOSK_OFFLINE and PUNCH_MISSING_OUT rows into `public.notifications`, and each
 * row carries its own `deep_link` to the screen it is about.
 *
 * Three deliberate choices:
 *
 *  * THE COUNTS ARE POSTGRES'S. "N unread" and the filtered total are
 *    `count=exact` HEAD requests built from the SAME filter array as the list
 *    (see notifications.api.ts). Counting loaded rows would make the badge depend
 *    on the page cap.
 *  * THE LIST IS SCOPED IN THE QUERY, NOT BY RLS. The admin RLS policy on this
 *    table lets an administrator read every row in the company; a `/me` screen
 *    that leaned on RLS for scoping would show an HR admin the whole company's
 *    feed. So the read filters on my own `profile_id`.
 *  * READ IS THE ONLY WRITE. `authenticated` holds `GRANT UPDATE (read_at,
 *    dismissed_at)` and nothing else, so this screen marks rows read (and can put
 *    one back to unread) and offers nothing it cannot actually do. There is no
 *    delete: the row is retained for twelve months by design.
 *
 * @route /me/notifications
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Bell, BellOff, CheckCheck, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { ROUTES } from "@/app/route-manifest";
import { Notice } from "@/features/admin/components/Notice";
import { SelectField } from "@/features/admin/components/Field";
import { fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { StatusMixCard } from "@/shared/ui/charts/StatusMixCard";
import {
  FEED_LIMIT,
  notificationChannelValues,
  notificationPriorityValues,
  type FeedFilters,
  type Notification,
  type NotificationChannel,
  type NotificationPriority,
  type ReadFilter,
} from "../api/notifications.api";
import {
  useEmployeeOnlyUnlisted,
  useMarkAllRead,
  useMarkNotification,
  useNotificationCount,
  useNotificationFeed,
  useUnreadCount,
} from "../hooks/useNotifications";

const CHANNEL_LABEL: Readonly<Record<NotificationChannel, string>> = {
  in_app: t("notif.channel.inApp"),
  email: t("notif.channel.email"),
  sms: t("notif.channel.sms"),
  whatsapp: t("notif.channel.whatsapp"),
  push: t("notif.channel.push"),
  kiosk_display: t("notif.channel.kiosk"),
};

const PRIORITY_CHIP: Readonly<Record<NotificationPriority, StatusChipEntry>> = {
  low: { label: t("notif.priority.low"), tone: "neutral" },
  normal: { label: t("notif.priority.normal"), tone: "info" },
  high: { label: t("notif.priority.high"), tone: "warn" },
  critical: { label: t("notif.priority.critical"), tone: "danger" },
};

const READ_OPTIONS: readonly { value: ReadFilter; label: string }[] = [
  { value: "all", label: t("notif.filter.all") },
  { value: "unread", label: t("notif.filter.unread") },
  { value: "read", label: t("notif.filter.read") },
];

/**
 * `event_code` is a template code (LEAVE_DECIDED, KIOSK_OFFLINE). The catalogue
 * that carries its friendly name — `notification_templates` — is admin-only, so
 * the code is humanised rather than pretending to a name we cannot read.
 */
function humaniseEventCode(code: string): string {
  const words = code.replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Does this notification's `deep_link` actually go anywhere in THIS app?
 *
 * It matters, because the server-side writers do not all agree with the router.
 * Live rows carry `/kiosk/devices` and `/approvals/<uuid>`, neither of which is a
 * route (the real ones are `/admin/kiosk/devices` and `/me/approvals`), while
 * `/team/attendance?date=…` is fine. An "Open" button that lands on Not Found is
 * worse than no button, so the link is matched against the route manifest first —
 * segment by segment, with `:param` segments matching anything — and the rows
 * whose target does not resolve say so instead.
 */
function resolvesToARoute(deepLink: string): boolean {
  const path = deepLink.split(/[?#]/)[0] ?? "";
  if (!path.startsWith("/")) return false;
  const parts = path.split("/").filter((s) => s !== "");
  return ROUTES.some((route) => {
    const pattern = route.path.split("/").filter((s) => s !== "");
    if (pattern.length !== parts.length) return false;
    return pattern.every((segment, i) => segment.startsWith(":") || segment === parts[i]);
  });
}

export default function NotificationsPage() {
  const [read, setRead] = useState<ReadFilter>("all");
  const [channel, setChannel] = useState<NotificationChannel | "">("");
  const [priority, setPriority] = useState<NotificationPriority | "">("");

  const filters = useMemo<FeedFilters>(
    () => ({
      read,
      ...(channel !== "" ? { channel } : {}),
      ...(priority !== "" ? { priority } : {}),
    }),
    [read, channel, priority],
  );

  const feed = useNotificationFeed(filters);
  const total = useNotificationCount(filters);
  const unread = useUnreadCount();
  const unlisted = useEmployeeOnlyUnlisted();
  const mark = useMarkNotification();
  const markAll = useMarkAllRead();

  const rows = feed.data ?? [];
  const hasFilter = read !== "all" || channel !== "" || priority !== "";
  const capped = total.isSuccess && total.data > rows.length;

  function clearFilters() {
    setRead("all");
    setChannel("");
    setPriority("");
  }

  const columns: DataGridColumn<Notification>[] = [
    {
      key: "recorded_at",
      header: t("notif.col.when"),
      width: "11rem",
      sortable: true,
      render: (row) => (
        <span className="num text-xs text-muted-foreground">{fmtDateTime(row.recorded_at)}</span>
      ),
    },
    {
      key: "title",
      header: t("notif.col.what"),
      render: (row) => (
        <span className="flex flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            {row.read_at === null ? (
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full bg-primary"
                aria-label={t("notif.filter.unread")}
              />
            ) : null}
            <span className={row.read_at === null ? "font-semibold" : "font-medium"}>
              {row.title}
            </span>
          </span>
          {row.body !== null ? (
            <span className="text-xs text-muted-foreground">{row.body}</span>
          ) : null}
          <span className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
            {humaniseEventCode(row.event_code)}
          </span>
        </span>
      ),
    },
    {
      key: "channel",
      header: t("notif.col.channel"),
      width: "8rem",
      hideBelow: "lg",
      render: (row) => dash(CHANNEL_LABEL[row.channel]),
    },
    {
      key: "priority",
      header: t("notif.col.priority"),
      width: "8rem",
      hideBelow: "md",
      render: (row) => <StatusChip status={row.priority} map={PRIORITY_CHIP} />,
    },
    {
      key: "status",
      header: t("notif.col.delivery"),
      width: "8rem",
      hideBelow: "lg",
      render: (row) => <StatusChip status={row.status} />,
    },
    {
      key: "actions",
      header: t("notif.col.actions"),
      width: "13rem",
      align: "right",
      render: (row) => (
        <span className="flex flex-wrap items-center justify-end gap-1">
          {row.deep_link !== null && resolvesToARoute(row.deep_link) ? (
            <Button asChild variant="ghost" size="sm">
              <Link to={row.deep_link}>
                <ExternalLink className="mr-1 size-3.5" aria-hidden />
                {t("notif.open")}
              </Link>
            </Button>
          ) : row.deep_link !== null ? (
            <span className="text-xs text-muted-foreground" title={row.deep_link}>
              {t("notif.deadLink")}
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            disabled={mark.isPending}
            onClick={() => mark.mutate({ id: row.id, read: row.read_at === null })}
          >
            {row.read_at === null ? t("notif.markRead") : t("notif.markUnread")}
          </Button>
        </span>
      ),
    },
  ];

  const subtitle = unread.isSuccess
    ? unread.data > 0
      ? t("notif.unread", { count: formatNumber(unread.data) })
      : t("notif.allRead")
    : t("notif.subtitle");

  return (
    <div className="container py-6">
      <PageHeader
        icon={Bell}
        title={t("notif.title")}
        subtitle={subtitle}
        actions={
          <Button
            variant="outline"
            disabled={markAll.isPending || !(unread.isSuccess && unread.data > 0)}
            onClick={() => markAll.mutate()}
          >
            <CheckCheck className="mr-2 size-4" aria-hidden />
            {t("notif.markAllRead")}
          </Button>
        }
      />

      {markAll.isError ? (
        <Notice tone="error" className="mb-3">
          {t("notif.markFailed")}
        </Notice>
      ) : null}
      {mark.isError ? (
        <Notice tone="error" className="mb-3">
          {t("notif.markFailed")}
        </Notice>
      ) : null}

      <div className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <SelectField
          label={t("notif.filter.state")}
          value={read}
          options={READ_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          onChange={(v) => setRead(v === "" ? "all" : (v as ReadFilter))}
        />
        <SelectField
          label={t("notif.filter.channel")}
          value={channel}
          placeholder={t("notif.filter.anyChannel")}
          options={notificationChannelValues.map((v) => ({ value: v, label: CHANNEL_LABEL[v] }))}
          onChange={(v) => setChannel(v as NotificationChannel | "")}
        />
        <SelectField
          label={t("notif.filter.priority")}
          value={priority}
          placeholder={t("notif.filter.anyPriority")}
          options={notificationPriorityValues.map((v) => ({
            value: v,
            label: PRIORITY_CHIP[v].label,
          }))}
          onChange={(v) => setPriority(v as NotificationPriority | "")}
        />
        <div className="flex items-end">
          {hasFilter ? (
            <Button type="button" variant="ghost" onClick={clearFilters}>
              {t("notif.filter.clear")}
            </Button>
          ) : null}
        </div>
      </div>

      {total.isSuccess ? (
        <p className="mt-3 text-sm text-muted-foreground">
          {t("notif.count", { count: formatNumber(total.data) })}
        </p>
      ) : null}

      {capped ? (
        <Notice tone="warning" className="mt-3">
          {t("notif.capped", { shown: formatNumber(rows.length), cap: formatNumber(FEED_LIMIT) })}
        </Notice>
      ) : null}

      {unlisted.isSuccess && unlisted.data > 0 ? (
        <Notice tone="warning" className="mt-3">
          {t("notif.unlisted", { count: formatNumber(unlisted.data) })}
        </Notice>
      ) : null}

      {/*
        READ AGAINST UNREAD. `unread` is a strict subset of the total, so the
        remainder is exact — and the proportion is the only thing a person wants
        from an inbox at a glance.
      */}
      {total.data !== undefined && unread.data !== undefined && total.data > 0 ? (
        <div className="mt-4">
          <StatusMixCard
            title={t("notif.mix.title")}
            hint={t("notif.mix.hint")}
            format={(v) => formatNumber(v)}
            totalCaption={(n) => t("notif.mix.total", { n: formatNumber(n) })}
            segments={[
              {
                key: "unread",
                label: t("notif.mix.unread"),
                value: unread.data,
                tone: "late",
              },
              {
                key: "read",
                label: t("notif.mix.read"),
                value: Math.max(total.data - unread.data, 0),
                tone: "present",
              },
            ]}
          />
        </div>
      ) : null}

      <div className="mt-4">
        <StateBoundary
          loading={feed.isPending}
          error={feed.error}
          onRetry={() => void feed.refetch()}
          isEmpty={rows.length === 0}
          partialError={total.error ?? unread.error}
          partialLabel={t("notif.partial.count")}
          empty={
            hasFilter ? (
              <EmptyState
                icon={BellOff}
                title={t("notif.empty.filtered.title")}
                hint={t("notif.empty.filtered.hint")}
                action={
                  <Button variant="outline" onClick={clearFilters}>
                    {t("notif.filter.clear")}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={BellOff}
                title={t("notif.empty.title")}
                hint={t("notif.empty.hint")}
              />
            )
          }
        >
          <DataGrid columns={columns} rows={rows} rowKey={(row) => row.id} pageSize={25} />
        </StateBoundary>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">{t("notif.footnote")}</p>
    </div>
  );
}
