/**
 * §14 · /admin/comms/delivery — Delivery Log. Sent, delivered, opened, bounced.
 *
 * "Delivery" is TWO different logs in this schema and the screen keeps them
 * apart, because merging them would invent a per-message history that email
 * does not have here:
 *
 *   `notifications` (migration 027 §6) — the per-user feed, partitioned
 *      quarterly on `recorded_at`. Every row carries its own lifecycle stamps
 *      (`sent_at`, `delivered_at`, `read_at`, `dismissed_at`), `retry_count` and
 *      `failure_detail`. Admin read is governance-only: writes are service-role,
 *      so nothing on this screen mutates a row.
 *   `communication_events` (migration 027 §5) — the append-only provider trail
 *      for outbound EMAIL: queued / sent / delivered / deferred / bounced /
 *      complained / opened / clicked / unsubscribed / signed, written by the
 *      Resend webhook after HMAC verification. Immutable by trigger.
 *
 * LIVE STATE, probed before the screen was written: `notifications` holds 6 rows
 * (KIOSK_OFFLINE, still `queued`, addressed to the two admin profiles);
 * `communication_events` is empty because nothing has been emailed — the project
 * has no `RESEND_API_KEY`, which /admin/comms/broadcasts says in as many words.
 * An empty provider trail is therefore the CORRECT reading, and the screen says
 * why rather than showing a blank table.
 *
 * Counts are `HEAD … count=exact` over the same predicate builder as the rows.
 * The recipient column resolves an `employee_id` to a name through the shared
 * directory read; a notification addressed to a `profile_id` with no employee row
 * (an admin, a super-admin) is labelled as such rather than dashed out.
 *
 * @route /admin/comms/delivery
 */
import { useMemo, useState } from "react";
import { Bell, Mail } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { StatusMixCard } from "@/shared/ui/charts/StatusMixCard";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { addIstDays, fmtDateTime, nowIstDate } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField, TextField } from "../components/Field";
import { channelLabel } from "../kiosk-display";
import { useEmployeeLabels } from "../hooks/useEmployeeLabels";
import {
  useCommunicationEventCount,
  useCommunicationEvents,
  useNotificationCount,
  useNotificationFeed,
} from "../hooks/useCommsAdmin";
import {
  notificationChannelSchema,
  notificationStatusSchema,
  type CommunicationEvent,
  type NotificationChannel,
  type NotificationFilters,
  type NotificationRow,
  type NotificationStatus,
} from "../api/comms.api";

const STATUS_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  queued: { label: t("admin.comms.del.status.queued"), tone: "neutral" },
  sending: { label: t("admin.comms.del.status.sending"), tone: "info" },
  sent: { label: t("admin.comms.del.status.sent"), tone: "info" },
  delivered: { label: t("admin.comms.del.status.delivered"), tone: "success" },
  opened: { label: t("admin.comms.del.status.opened"), tone: "success" },
  clicked: { label: t("admin.comms.del.status.clicked"), tone: "success" },
  failed: { label: t("admin.comms.del.status.failed"), tone: "danger" },
  bounced: { label: t("admin.comms.del.status.bounced"), tone: "danger" },
  suppressed: { label: t("admin.comms.del.status.suppressed"), tone: "warn" },
  cancelled: { label: t("admin.comms.del.status.cancelled"), tone: "neutral" },
};

const STATUS_LABEL: Readonly<Record<NotificationStatus, string>> = {
  queued: t("admin.comms.del.status.queued"),
  sending: t("admin.comms.del.status.sending"),
  sent: t("admin.comms.del.status.sent"),
  delivered: t("admin.comms.del.status.delivered"),
  opened: t("admin.comms.del.status.opened"),
  clicked: t("admin.comms.del.status.clicked"),
  failed: t("admin.comms.del.status.failed"),
  bounced: t("admin.comms.del.status.bounced"),
  suppressed: t("admin.comms.del.status.suppressed"),
  cancelled: t("admin.comms.del.status.cancelled"),
};

/**
 * `ck_communication_events__event` — the PROVIDER vocabulary, which is not the
 * `notification_status` vocabulary. Six values happen to share a spelling with a
 * notification status; four (`deferred`, `complained`, `unsubscribed`, `signed`)
 * exist only here. Mapped in full so no provider event ever falls through to an
 * untranslated, neutral-toned label — a spam complaint is a deliverability
 * emergency and must not render the same grey as "queued".
 */
const EVENT_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  queued: { label: t("admin.comms.del.event.queued"), tone: "neutral" },
  sent: { label: t("admin.comms.del.event.sent"), tone: "info" },
  delivered: { label: t("admin.comms.del.event.delivered"), tone: "success" },
  deferred: { label: t("admin.comms.del.event.deferred"), tone: "warn" },
  bounced: { label: t("admin.comms.del.event.bounced"), tone: "danger" },
  complained: { label: t("admin.comms.del.event.complained"), tone: "danger" },
  opened: { label: t("admin.comms.del.event.opened"), tone: "success" },
  clicked: { label: t("admin.comms.del.event.clicked"), tone: "success" },
  unsubscribed: { label: t("admin.comms.del.event.unsubscribed"), tone: "warn" },
  signed: { label: t("admin.comms.del.event.signed"), tone: "success" },
};

const PRIORITY_VARIANT: Readonly<Record<string, "neutral" | "info" | "warning" | "danger">> = {
  low: "neutral",
  normal: "info",
  high: "warning",
  critical: "danger",
};

/** The default window: the last 30 IST days, inclusive. */
const WINDOW_DAYS = 30;

export default function DeliveryLogPage() {
  const today = nowIstDate();
  const [fromDate, setFromDate] = useState(() => addIstDays(nowIstDate(), -WINDOW_DAYS));
  const [toDate, setToDate] = useState(today);
  const [status, setStatus] = useState<NotificationStatus | "">("");
  const [channel, setChannel] = useState<NotificationChannel | "">("");
  const [eventCode, setEventCode] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);

  const filters = useMemo<NotificationFilters>(
    () => ({
      fromDate,
      toDate,
      ...(status !== "" ? { statuses: [status] } : {}),
      ...(channel !== "" ? { channels: [channel] } : {}),
      ...(eventCode.trim() !== "" ? { eventCode: eventCode.trim() } : {}),
      ...(unreadOnly ? { unreadOnly: true } : {}),
    }),
    [fromDate, toDate, status, channel, eventCode, unreadOnly],
  );

  const list = useNotificationFeed(filters);
  const total = useNotificationCount(filters);
  const rows = useMemo(() => list.data ?? [], [list.data]);

  // Tiles: four server counts over the SAME window as the grid.
  const windowOnly = useMemo(() => ({ fromDate, toDate }), [fromDate, toDate]);
  const queuedCount = useNotificationCount({ ...windowOnly, statuses: ["queued", "sending"] });
  const deliveredCount = useNotificationCount({
    ...windowOnly,
    statuses: ["delivered", "opened", "clicked"],
  });
  const failedCount = useNotificationCount({
    ...windowOnly,
    statuses: ["failed", "bounced", "suppressed"],
  });
  const unreadCount = useNotificationCount({ ...windowOnly, unreadOnly: true });

  const events = useCommunicationEvents({});
  const eventCount = useCommunicationEventCount({});
  const eventRows = useMemo(() => events.data ?? [], [events.data]);

  const labels = useEmployeeLabels();

  const anyFilter = status !== "" || channel !== "" || eventCode.trim() !== "" || unreadOnly;
  const clearAll = () => {
    setStatus("");
    setChannel("");
    setEventCode("");
    setUnreadOnly(false);
  };

  const columns: DataGridColumn<NotificationRow>[] = [
    {
      key: "recorded_at",
      header: t("admin.comms.del.col.recordedAt"),
      width: "12rem",
      sortable: true,
      render: (row) => <span className="text-xs">{fmtDateTime(row.recorded_at)}</span>,
    },
    {
      key: "title",
      header: t("admin.comms.del.col.message"),
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="text-sm font-medium">{row.title}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{row.event_code}</span>
          {row.body !== null ? (
            <span className="mt-0.5 max-w-lg truncate text-xs text-muted-foreground">
              {row.body}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "recipient",
      header: t("admin.comms.del.col.recipient"),
      width: "13rem",
      render: (row) => {
        if (row.employee_id === null) {
          return (
            <span className="text-xs text-muted-foreground">
              {t("admin.comms.del.accountOnly")}
            </span>
          );
        }
        const who = labels.data?.get(row.employee_id) ?? null;
        return <PersonCell name={who?.name ?? null} code={who?.code ?? null} />;
      },
    },
    {
      key: "channel",
      header: t("admin.comms.del.col.channel"),
      width: "8rem",
      render: (row) => <span className="text-sm">{channelLabel(row.channel)}</span>,
    },
    {
      key: "status",
      header: t("admin.comms.del.col.status"),
      width: "10rem",
      render: (row) => (
        <span className="flex flex-wrap items-center gap-1">
          <StatusChip status={row.status} map={STATUS_CHIP} />
          {row.priority !== "normal" ? (
            <Badge variant={PRIORITY_VARIANT[row.priority] ?? "neutral"}>{row.priority}</Badge>
          ) : null}
        </span>
      ),
    },
    {
      key: "lifecycle",
      header: t("admin.comms.del.col.lifecycle"),
      width: "14rem",
      hideBelow: "lg",
      render: (row) => (
        <span className="flex flex-col leading-tight text-xs text-muted-foreground">
          <span>
            {t("admin.comms.del.sentAt")}{" "}
            {row.sent_at !== null ? fmtDateTime(row.sent_at) : dash(null)}
          </span>
          <span>
            {t("admin.comms.del.readAt")}{" "}
            {row.read_at !== null ? fmtDateTime(row.read_at) : dash(null)}
          </span>
          {row.retry_count > 0 ? (
            <span>{t("admin.comms.del.retries", { n: formatNumber(row.retry_count) })}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: "failure_detail",
      header: t("admin.comms.del.col.failure"),
      hideBelow: "lg",
      render: (row) => (
        <span className="block max-w-xs break-words text-xs text-destructive">
          {row.failure_detail ?? ""}
        </span>
      ),
    },
  ];

  const eventColumns: DataGridColumn<CommunicationEvent>[] = [
    {
      key: "occurred_at",
      header: t("admin.comms.del.col.occurredAt"),
      width: "12rem",
      render: (row) => <span className="text-xs">{fmtDateTime(row.occurred_at)}</span>,
    },
    {
      key: "event",
      header: t("admin.comms.del.col.event"),
      width: "10rem",
      render: (row) => <StatusChip status={row.event} map={EVENT_CHIP} />,
    },
    {
      key: "provider",
      header: t("admin.comms.del.col.provider"),
      width: "10rem",
      render: (row) => <span className="text-sm">{dash(row.provider)}</span>,
    },
    {
      key: "communication_id",
      header: t("admin.comms.del.col.communication"),
      render: (row) => <span className="font-mono text-xs">{row.communication_id}</span>,
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={Bell}
        title={t("admin.comms.del.title")}
        subtitle={
          total.isSuccess
            ? t("admin.comms.del.subtitle", { n: formatNumber(total.data) })
            : t("admin.comms.del.subtitlePlain")
        }
      />

      <section className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label={t("admin.comms.del.kpi.queued")}
          value={queuedCount.isSuccess ? formatNumber(queuedCount.data) : dash(null)}
          tone={queuedCount.data !== undefined && queuedCount.data > 0 ? "warn" : "neutral"}
          hint={t("admin.comms.del.kpi.queuedHint")}
        />
        <KpiTile
          label={t("admin.comms.del.kpi.delivered")}
          value={deliveredCount.isSuccess ? formatNumber(deliveredCount.data) : dash(null)}
          tone="success"
          hint={t("admin.comms.del.kpi.deliveredHint")}
        />
        <KpiTile
          label={t("admin.comms.del.kpi.failed")}
          value={failedCount.isSuccess ? formatNumber(failedCount.data) : dash(null)}
          tone={failedCount.data !== undefined && failedCount.data > 0 ? "danger" : "neutral"}
          hint={t("admin.comms.del.kpi.failedHint")}
        />
        <KpiTile
          label={t("admin.comms.del.kpi.unread")}
          value={unreadCount.isSuccess ? formatNumber(unreadCount.data) : dash(null)}
          hint={t("admin.comms.del.kpi.unreadHint")}
        />
      </section>

      {/*
        DID THE MESSAGES ARRIVE. Three of the four tiles above are the delivery
        outcome of one notification each — queued, delivered, failed — and
        `notifications.status` holds one of them per row, so the three are
        disjoint and the bar is exact.

        `unread` is deliberately NOT a band: an unread message was delivered
        successfully, so it belongs to the delivered slice. Adding it would count
        those rows twice and make the failure share look smaller than it is —
        which is the one number on this screen somebody acts on.
      */}
      <div className="mb-4">
        <StatusMixCard
          title={t("admin.comms.del.mix.title")}
          hint={t("admin.comms.del.mix.hint")}
          format={(v) => formatNumber(v)}
          totalCaption={(n) => t("admin.comms.del.mix.total", { n: formatNumber(n) })}
          segments={[
            {
              key: "delivered",
              label: t("admin.comms.del.kpi.delivered"),
              value: deliveredCount.data,
              tone: "present",
            },
            {
              key: "queued",
              label: t("admin.comms.del.kpi.queued"),
              value: queuedCount.data,
              tone: "late",
            },
            {
              key: "failed",
              label: t("admin.comms.del.kpi.failed"),
              value: failedCount.data,
              tone: "absent",
            },
          ]}
        />
      </div>

      <div className="mb-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-3">
        <TextField
          label={t("admin.comms.del.filter.from")}
          type="date"
          value={fromDate}
          onChange={setFromDate}
          max={toDate}
        />
        <TextField
          label={t("admin.comms.del.filter.to")}
          type="date"
          value={toDate}
          onChange={setToDate}
          min={fromDate}
          hint={t("admin.comms.del.filter.windowHint")}
        />
        <SelectField
          label={t("admin.comms.del.filter.status")}
          value={status}
          placeholder={t("admin.comms.del.filter.anyStatus")}
          options={notificationStatusSchema.options.map((s) => ({
            value: s,
            label: STATUS_LABEL[s],
          }))}
          onChange={(v) => setStatus(v as NotificationStatus | "")}
        />
        <SelectField
          label={t("admin.comms.del.filter.channel")}
          value={channel}
          placeholder={t("admin.comms.del.filter.anyChannel")}
          options={notificationChannelSchema.options.map((c) => ({
            value: c,
            label: channelLabel(c),
          }))}
          onChange={(v) => setChannel(v as NotificationChannel | "")}
        />
        <TextField
          label={t("admin.comms.del.filter.eventCode")}
          value={eventCode}
          onChange={setEventCode}
          placeholder="KIOSK_OFFLINE"
          hint={t("admin.comms.del.filter.eventCodeHint")}
        />
        <div className="flex items-end gap-2">
          <Button
            type="button"
            variant={unreadOnly ? "default" : "outline"}
            aria-pressed={unreadOnly}
            onClick={() => setUnreadOnly((v) => !v)}
          >
            {t("admin.comms.del.filter.unreadOnly")}
          </Button>
          {anyFilter ? (
            <Button type="button" variant="ghost" onClick={clearAll}>
              {t("admin.comms.del.filter.clear")}
            </Button>
          ) : null}
          <p className="ml-auto text-sm text-muted-foreground">
            {total.isSuccess
              ? t("admin.comms.del.matching", { n: formatNumber(total.data) })
              : t("admin.comms.del.matchingUnknown")}
          </p>
        </div>
      </div>

      <StateBoundary
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        isEmpty={rows.length === 0}
        partialError={total.error ?? labels.error}
        partialLabel={t("admin.comms.del.partial.names")}
        empty={
          <EmptyState
            icon={Bell}
            title={t("admin.comms.del.empty.title")}
            hint={
              anyFilter ? t("admin.comms.del.empty.filteredHint") : t("admin.comms.del.empty.hint")
            }
            {...(anyFilter
              ? {
                  action: (
                    <Button variant="outline" onClick={clearAll}>
                      {t("admin.comms.del.filter.clear")}
                    </Button>
                  ),
                }
              : {})}
          />
        }
        skeletonRows={5}
      >
        <DataGrid columns={columns} rows={rows} rowKey={(row) => row.id} pageSize={25} />
      </StateBoundary>

      <section className="mt-8">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="font-display text-lg font-semibold">{t("admin.comms.del.email")}</h2>
            <p className="text-sm text-muted-foreground">{t("admin.comms.del.emailHint")}</p>
          </div>
          <Badge variant="neutral">
            {eventCount.isSuccess
              ? t("admin.comms.del.eventCount", { n: formatNumber(eventCount.data) })
              : t("admin.comms.del.eventCountUnknown")}
          </Badge>
        </div>
        <StateBoundary
          loading={events.isPending}
          error={events.error}
          onRetry={() => void events.refetch()}
          isEmpty={eventRows.length === 0}
          partialError={eventCount.error}
          partialLabel={t("admin.comms.del.partial.events")}
          empty={
            <EmptyState
              icon={Mail}
              title={t("admin.comms.del.empty.events.title")}
              hint={t("admin.comms.del.empty.events.hint")}
            />
          }
          skeletonRows={3}
        >
          <DataGrid
            columns={eventColumns}
            rows={eventRows}
            rowKey={(row) => row.id}
            pageSize={25}
          />
        </StateBoundary>
      </section>

      <div className="mt-6">
        <Notice tone="info">{t("admin.comms.del.readOnlyNote")}</Notice>
      </div>
      <p className="mt-4 text-xs text-muted-foreground">{t("admin.comms.del.footnote")}</p>
    </div>
  );
}
