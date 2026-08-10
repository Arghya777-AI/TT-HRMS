/**
 * §14 · /admin/comms/helpdesk — Help Desk. Tickets across every queue, with
 * service levels.
 *
 * ── THIS SCREEN HAD NO BACKEND, AND THAT WAS THE FINDING ─────────────────────
 *
 * Probed live as the HR-admin persona, it used to answer:
 *
 *     GET /rest/v1/helpdesk_tickets?select=id
 *     → 404 {"code":"PGRST205",
 *            "message":"Could not find the table 'public.helpdesk_tickets'
 *                       in the schema cache"}
 *
 * and no migration created one. So the page showed the `help_desk` feature-flag
 * row and nothing that looked like a queue, on the grounds that a fabricated
 * queue here would be the most damaging thing on the console: an HR admin would
 * believe nobody had raised anything.
 *
 * Migration 041500 created `helpdesk_tickets`, `helpdesk_messages`, both SLA
 * clocks and `helpdesk_desk_action`, and flipped the flag it had been quoting.
 * This is the queue.
 *
 * ── WHY THE ACTIONS ARE AN RPC AND NOT SIX COLUMN WRITES ─────────────────────
 *
 * Status and timestamp move together, and `ck_hdt__resolved_status` makes the
 * pair mandatory. A browser that sets `status = 'resolved'` must therefore also
 * supply `resolved_at` — the number every SLA report is judged on. The server's
 * clock decides that, so every button here calls `helpdesk_desk_action`.
 *
 * ── WHAT IS STILL NOT HERE, AND IS NOT FAKED ─────────────────────────────────
 *
 * REASSIGNMENT TO SOMEONE ELSE. There is no desk-membership table, so there is
 * no list of "people on the IT desk" to pick from, and offering the whole
 * directory would let a ticket be parked on a chef. "Claim" — assign to
 * yourself — is the one assignment that is unambiguously right, so it is the one
 * offered. Bulk actions and per-desk SLA policies are likewise absent rather
 * than approximated.
 *
 * @route /admin/comms/helpdesk
 */
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { LifeBuoy, MessageSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { cn } from "@/lib/utils";
import { fmtDateTime } from "@/lib/datetime";
import { formatNumber } from "@/lib/format";
import { mutationUserMessage } from "@/shared/api/query";
import { type MessageKey, t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import {
  deskSliceValues,
  isDeskSlice,
  type DeskSlice,
  type DeskTicket,
} from "../api/helpdesk-desk.api";
import {
  helpdeskDeskValues,
  isBreached,
  type HelpdeskDesk,
} from "@/features/helpdesk/api/helpdesk.api";
import {
  useDeskAction,
  useDeskMessages,
  useDeskTicketCount,
  useDeskTickets,
  useMyProfileId,
  usePostDeskMessage,
} from "../hooks/useHelpdeskDesk";

const TICKET_STATUS_MAP: Record<string, StatusChipEntry> = {
  open: { label: t("helpdesk.ticket.status.open"), tone: "info" },
  in_progress: { label: t("helpdesk.ticket.status.in_progress"), tone: "info" },
  waiting_on_requester: { label: t("helpdesk.ticket.status.waiting"), tone: "warn" },
  resolved: { label: t("helpdesk.ticket.status.resolved"), tone: "success" },
  closed: { label: t("helpdesk.ticket.status.closed"), tone: "neutral" },
  cancelled: { label: t("helpdesk.ticket.status.cancelled"), tone: "neutral" },
};

const SLICE_TONE: Readonly<Record<DeskSlice, string>> = {
  live: "border-info/50",
  unassigned: "border-warning/50",
  mine: "border-primary/50",
  resolved: "border-success/50",
  all: "border-border",
};

/** One tile. Its own query, so a failing tile cannot blank the other four. */
function SliceTile({
  slice,
  desk,
  active,
  onSelect,
}: {
  slice: DeskSlice;
  desk: HelpdeskDesk | null;
  active: boolean;
  onSelect: () => void;
}) {
  const count = useDeskTicketCount(slice, desk);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        SLICE_TONE[slice],
        active && "ring-2 ring-primary",
      )}
    >
      <p className="text-xs text-muted-foreground">{t(`admin.hd.slice.${slice}` as MessageKey)}</p>
      <p className="num mt-1 font-display text-2xl font-semibold">
        {count.isPending
          ? "…"
          : count.error !== null
            ? t("common.empty")
            : formatNumber(count.data ?? 0)}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {t(`admin.hd.slice.${slice}.hint` as MessageKey)}
      </p>
    </button>
  );
}

/** The conversation, the internal notes, and everything the desk can do. */
function DeskTicketDetail({ ticket }: { ticket: DeskTicket }) {
  const messages = useDeskMessages(ticket.id);
  const post = usePostDeskMessage();
  const act = useDeskAction();
  const myProfileId = useMyProfileId();
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [note, setNote] = useState("");

  const mine = ticket.assigned_to !== null && ticket.assigned_to === myProfileId;
  const finished = ticket.status === "closed" || ticket.status === "cancelled";

  return (
    <div className="space-y-3 px-1 py-2">
      <p className="whitespace-pre-wrap text-sm">{ticket.description}</p>

      <dl className="grid gap-3 rounded-md border bg-muted/40 px-3 py-2.5 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">
            {t("admin.hd.field.firstReply")}
          </dt>
          <dd className="mt-0.5">
            {ticket.first_responded_at !== null
              ? fmtDateTime(ticket.first_responded_at)
              : ticket.first_response_due_at !== null
                ? t("admin.hd.field.dueBy", { when: fmtDateTime(ticket.first_response_due_at) })
                : t("common.empty")}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">
            {t("admin.hd.field.resolve")}
          </dt>
          <dd className="mt-0.5">
            {ticket.resolved_at !== null
              ? fmtDateTime(ticket.resolved_at)
              : ticket.resolution_due_at !== null
                ? t("admin.hd.field.dueBy", { when: fmtDateTime(ticket.resolution_due_at) })
                : t("common.empty")}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">
            {t("admin.hd.field.reopened")}
          </dt>
          <dd className="mt-0.5">{formatNumber(ticket.reopened_count)}</dd>
        </div>
      </dl>

      {ticket.resolution_note !== null ? (
        <div className="rounded-md border bg-card p-3 text-sm">
          <p className="font-medium">{t("helpdesk.ticket.resolution")}</p>
          <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{ticket.resolution_note}</p>
        </div>
      ) : null}

      <section aria-label={t("helpdesk.ticket.conversation")}>
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          <MessageSquare className="size-3.5 text-muted-foreground" aria-hidden />
          {t("helpdesk.ticket.conversation")}
        </h3>
        <StateBoundary
          loading={messages.isLoading}
          error={messages.error ?? undefined}
          onRetry={() => void messages.refetch()}
          isEmpty={messages.data !== undefined && messages.data.length === 0}
          empty={<p className="mt-1 text-sm text-muted-foreground">{t("admin.hd.noMessages")}</p>}
          skeletonRows={1}
        >
          <ul className="mt-2 space-y-2">
            {(messages.data ?? []).map((m) => (
              <li
                key={m.id}
                className={cn(
                  "rounded-md border p-2.5 text-sm",
                  m.is_internal ? "border-warning/50 bg-warning/5" : "bg-card",
                )}
              >
                {m.is_internal ? (
                  <Badge variant="warning" className="mb-1">{t("admin.hd.internal")}</Badge>
                ) : null}
                <p className="whitespace-pre-wrap">{m.body}</p>
                <p className="mt-1 text-xs text-muted-foreground">{fmtDateTime(m.created_at)}</p>
              </li>
            ))}
          </ul>
        </StateBoundary>
      </section>

      {!finished ? (
        <div>
          <label className="text-sm font-medium" htmlFor={`hd-desk-reply-${ticket.id}`}>
            {t("admin.hd.reply")}
          </label>
          <textarea
            id={`hd-desk-reply-${ticket.id}`}
            rows={2}
            maxLength={5000}
            className="mt-1.5 w-full rounded-md border border-input bg-background p-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <label className="mt-1.5 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 rounded border-input"
              checked={internal}
              onChange={(e) => setInternal(e.target.checked)}
            />
            {t("admin.hd.internalToggle")}
          </label>
          {post.isError ? (
            <div className="mt-2"><Notice tone="error">{mutationUserMessage(post.error)}</Notice></div>
          ) : null}
          <Button
            size="sm"
            className="mt-2"
            disabled={body.trim() === "" || post.isPending}
            onClick={() => {
              if (body.trim() === "") return;
              post.mutate(
                { ticketId: ticket.id, body, isInternal: internal },
                { onSuccess: () => { setBody(""); } },
              );
            }}
          >
            {post.isPending ? t("helpdesk.ticket.sending") : t("admin.hd.sendReply")}
          </Button>
        </div>
      ) : null}

      {/* ── The desk's vocabulary, exactly as helpdesk_desk_action defines it ─ */}
      <div className="rounded-md border bg-card p-3">
        <p className="text-sm font-medium">{t("admin.hd.actions")}</p>
        {act.isError ? (
          <div className="mt-2"><Notice tone="error">{mutationUserMessage(act.error)}</Notice></div>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-2">
          {!mine && !finished ? (
            <Button
              size="sm"
              variant="outline"
              disabled={act.isPending}
              onClick={() => act.mutate({ ticketId: ticket.id, action: "claim", note: null })}
            >
              {t("admin.hd.action.claim")}
            </Button>
          ) : null}
          {ticket.status === "open" || ticket.status === "waiting_on_requester" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={act.isPending}
              onClick={() => act.mutate({ ticketId: ticket.id, action: "start", note: null })}
            >
              {t("admin.hd.action.start")}
            </Button>
          ) : null}
          {ticket.status === "in_progress" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={act.isPending}
              onClick={() => act.mutate({ ticketId: ticket.id, action: "wait", note: null })}
            >
              {t("admin.hd.action.wait")}
            </Button>
          ) : null}
          {ticket.status === "resolved" ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={act.isPending}
                onClick={() => act.mutate({ ticketId: ticket.id, action: "close", note: null })}
              >
                {t("admin.hd.action.close")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={act.isPending}
                onClick={() => act.mutate({ ticketId: ticket.id, action: "reopen", note: null })}
              >
                {t("admin.hd.action.reopen")}
              </Button>
            </>
          ) : null}
        </div>

        {/*
          Resolving takes a note, and the RPC refuses one shorter than five
          characters. A ticket resolved with nothing written on it is a ticket
          the requester has to ask about again.
        */}
        {!finished && ticket.status !== "resolved" ? (
          <div className="mt-3">
            <label className="text-sm font-medium" htmlFor={`hd-note-${ticket.id}`}>
              {t("admin.hd.resolveNote")}
            </label>
            <textarea
              id={`hd-note-${ticket.id}`}
              rows={2}
              maxLength={2000}
              className="mt-1.5 w-full rounded-md border border-input bg-background p-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <Button
              size="sm"
              className="mt-2"
              disabled={note.trim().length < 5 || act.isPending}
              onClick={() => {
                if (note.trim().length < 5) return;
                act.mutate(
                  { ticketId: ticket.id, action: "resolve", note },
                  { onSuccess: () => { setNote(""); } },
                );
              }}
            >
              {t("admin.hd.action.resolve")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function HelpdeskPage() {
  const [params, setParams] = useSearchParams();
  const sliceParam = params.get("slice");
  const slice: DeskSlice = isDeskSlice(sliceParam) ? sliceParam : "live";
  const deskParam = params.get("desk");
  const desk: HelpdeskDesk | null =
    deskParam !== null && (helpdeskDeskValues as readonly string[]).includes(deskParam)
      ? (deskParam as HelpdeskDesk)
      : null;

  const [openId, setOpenId] = useState<string | null>(null);
  const tickets = useDeskTickets(slice, desk);

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: true });
  }

  /*
    One clock reading for the whole render. Date.now() inside a column renderer
    would give two rows in the same table different "now"s.
  */
  const nowMs = Date.now();

  const columns: DataGridColumn<DeskTicket>[] = [
    {
      key: "ticket_number",
      header: t("helpdesk.col.ref"),
      width: "11rem",
      render: (row) => <span className="font-mono text-xs">{row.ticket_number}</span>,
    },
    {
      key: "subject",
      header: t("helpdesk.col.subject"),
      render: (row) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <span>{row.subject}</span>
          {isBreached(row.first_response_due_at, row.first_responded_at, nowMs) ? (
            <Badge variant="warning">{t("helpdesk.col.lateReply")}</Badge>
          ) : null}
          {isBreached(row.resolution_due_at, row.resolved_at, nowMs) ? (
            <Badge variant="destructive">{t("helpdesk.col.lateFix")}</Badge>
          ) : null}
        </span>
      ),
    },
    {
      key: "desk",
      header: t("helpdesk.col.desk"),
      width: "9rem",
      hideBelow: "md",
      render: (row) => t(`helpdesk.desk.${row.desk}` as MessageKey),
    },
    {
      key: "priority",
      header: t("admin.hd.col.priority"),
      width: "8rem",
      hideBelow: "lg",
      render: (row) => t(`helpdesk.priority.${row.priority}` as MessageKey),
    },
    {
      key: "assigned_to",
      header: t("admin.hd.col.assigned"),
      width: "9rem",
      hideBelow: "lg",
      /*
        Whether it is picked up, not who by. Resolving a profile id to a name
        needs a directory read this screen does not make, and a raw uuid in a
        column headed "Assigned" is worse than the honest yes/no.
      */
      render: (row) =>
        row.assigned_to === null ? (
          <Badge variant="warning">{t("admin.hd.unassigned")}</Badge>
        ) : (
          <Badge variant="neutral">{t("admin.hd.assigned")}</Badge>
        ),
    },
    {
      key: "status",
      header: t("helpdesk.col.status"),
      width: "11rem",
      render: (row) => <StatusChip status={row.status} map={TICKET_STATUS_MAP} />,
    },
    {
      key: "created_at",
      header: t("helpdesk.col.raised"),
      width: "13rem",
      hideBelow: "lg",
      sortable: true,
      render: (row) => fmtDateTime(row.created_at),
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={LifeBuoy}
        title={t("admin.comms.hd.title")}
        subtitle={t("admin.comms.hd.subtitle")}
      />

      <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {deskSliceValues.map((value) => (
          <SliceTile
            key={value}
            slice={value}
            desk={desk}
            active={slice === value}
            onSelect={() => setParam("slice", value === "live" ? "" : value)}
          />
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">{t("admin.hd.filter.desk")}</span>
        <Button
          size="sm"
          variant={desk === null ? "default" : "outline"}
          onClick={() => setParam("desk", "")}
        >
          {t("admin.hd.filter.allDesks")}
        </Button>
        {helpdeskDeskValues.map((d) => (
          <Button
            key={d}
            size="sm"
            variant={desk === d ? "default" : "outline"}
            onClick={() => setParam("desk", d)}
          >
            {t(`helpdesk.desk.${d}` as MessageKey)}
          </Button>
        ))}
      </div>

      <div className="mt-4">
        <StateBoundary
          loading={tickets.isLoading}
          error={tickets.error ?? undefined}
          onRetry={() => void tickets.refetch()}
        >
          <DataGrid
            columns={columns}
            rows={tickets.data ?? []}
            rowKey={(row) => row.id}
            pageSize={25}
            onRowClick={(row) => setOpenId(openId === row.id ? null : row.id)}
            renderRowDetail={(row) => (row.id === openId ? <DeskTicketDetail ticket={row} /> : null)}
            emptyState={
              <EmptyState
                icon={LifeBuoy}
                title={t("admin.hd.empty.title")}
                hint={t("admin.hd.empty.hint")}
              />
            }
          />
        </StateBoundary>
      </div>

      <section className="mt-6 rounded-lg border bg-card p-4">
        <h2 className="font-display text-lg font-semibold">{t("admin.comms.hd.insteadTitle")}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{t("admin.hd.relatedHint")}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link to="/admin/workflow/inbox">{t("admin.comms.hd.link.inbox")}</Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/admin/workflow/sla">{t("admin.comms.hd.link.sla")}</Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/admin/comms/announcements">{t("admin.comms.hd.link.announcements")}</Link>
          </Button>
        </div>
      </section>

      <p className="mt-4 text-xs text-muted-foreground">{t("admin.hd.footnote")}</p>
    </div>
  );
}
