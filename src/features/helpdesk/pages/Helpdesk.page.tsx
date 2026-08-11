/**
 * E-14 · /me/helpdesk — Help Desk.
 *
 * ── THIS PAGE USED TO BE AN HONEST GAP, AND IS NOT ANY MORE ──────────────────
 *
 * For its whole life this screen rendered a notice saying the backing table did
 * not exist, and it was telling the truth. Probed on the live project as an
 * employee:
 *
 *     GET /rest/v1/helpdesk_tickets  →  404 PGRST205
 *       "Could not find the table 'public.helpdesk_tickets' in the schema cache"
 *
 * `grep -rn helpdesk supabase/migrations/` returned nothing: no ticket table, no
 * SLA table, no ticket-comment table, and so nothing to read and nowhere to
 * write. Rendering approval rows here under a "your tickets" heading would have
 * been the mislabelling DR-08/DR-09 exist to prevent, so the page rendered
 * neither.
 *
 * Migration 041500 created `helpdesk_tickets` and `helpdesk_messages` with both
 * service-level clocks; migration 041000 created `document_requests`. Those are
 * the two things this page now does, and they are different objects on purpose:
 *
 *   · a DOCUMENT REQUEST is routed through the approval engine — HR either
 *     issues the paper or does not,
 *   · a TICKET has an assignee and a conversation, and can be reopened.
 *
 * ── A TICKET IS NOT THE THING /me/helpdesk/:id OPENS ─────────────────────────
 *
 * That sibling route renders an APPROVAL REQUEST thread and says so in its own
 * banner. Rows in the list below are `helpdesk_tickets` and expand in place
 * rather than navigating, so the two never collide — and they take different
 * query keys for the same reason (see the comment on `qk.helpdesk`).
 *
 * ── WHAT IS STILL NOT HERE ───────────────────────────────────────────────────
 *
 * There is no desk-membership table, so administrators are the desk: the
 * assignee picker, the internal-note composer and the desk-side queue belong on
 * an admin screen and are not faked here. Attachments are not offered —
 * `documents` has no ticket linkage — and nothing on this page pretends
 * otherwise.
 *
 * @route /me/helpdesk
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { ClipboardList, FileText, LifeBuoy, MessageSquare, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Required } from "@/shared/ui/Required";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { Badge } from "@/components/ui/badge";
import { Notice } from "@/features/admin/components/Notice";
import { mutationUserMessage } from "@/shared/api/query";
import { blockerButtonProps, SubmitBlockers, useSubmitAttempt } from "@/shared/ui/SubmitBlockers";
import { fmtDateTime, nowIstDate } from "@/lib/datetime";
import { type MessageKey, t } from "@/shared/i18n/en";
import { documentKindValues, type DocumentKind } from "@/features/apply/api/simple-requests.api";
import { useSubmitDocumentRequest } from "@/features/apply/hooks/useApply";
import {
  canReply,
  helpdeskDeskValues,
  helpdeskPriorityValues,
  isBreached,
  type HelpdeskDesk,
  type HelpdeskPriority,
  type HelpdeskTicket,
} from "../api/helpdesk.api";
import {
  useMyTickets,
  usePostTicketMessage,
  useRaiseTicket,
  useSetTicketStatus,
  useTicketMessages,
} from "../hooks/useHelpdesk";

/** Kinds that cover a stretch of time rather than a fact about today. */
const PERIODIC_KINDS: readonly DocumentKind[] = ["payslip", "salary_certificate", "form16"];

/** `ck_hdt__status`, each with the tone that says what it means at a glance. */
const TICKET_STATUS_MAP: Record<string, StatusChipEntry> = {
  open: { label: t("helpdesk.ticket.status.open"), tone: "info" },
  in_progress: { label: t("helpdesk.ticket.status.in_progress"), tone: "info" },
  waiting_on_requester: { label: t("helpdesk.ticket.status.waiting"), tone: "warn" },
  resolved: { label: t("helpdesk.ticket.status.resolved"), tone: "success" },
  closed: { label: t("helpdesk.ticket.status.closed"), tone: "neutral" },
  cancelled: { label: t("helpdesk.ticket.status.cancelled"), tone: "neutral" },
};

/** The conversation on one ticket, plus the box to add to it. */
function TicketDetail({ ticket }: { ticket: HelpdeskTicket }) {
  const messages = useTicketMessages(ticket.id);
  const post = usePostTicketMessage();
  const setStatus = useSetTicketStatus();
  const [body, setBody] = useState("");

  const replyAllowed = canReply(ticket.status);

  return (
    <div className="space-y-3 px-1 py-2">
      <p className="whitespace-pre-wrap text-sm">{ticket.description}</p>

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
          empty={<p className="mt-1 text-sm text-muted-foreground">{t("helpdesk.ticket.noReplies")}</p>}
          skeletonRows={1}
        >
          <ul className="mt-2 space-y-2">
            {(messages.data ?? []).map((m) => (
              <li key={m.id} className="rounded-md border bg-card p-2.5 text-sm">
                <p className="whitespace-pre-wrap">{m.body}</p>
                <p className="mt-1 text-xs text-muted-foreground">{fmtDateTime(m.created_at)}</p>
              </li>
            ))}
          </ul>
        </StateBoundary>
      </section>

      {replyAllowed ? (
        <div>
          <Label htmlFor={`hd-reply-${ticket.id}`}>{t("helpdesk.ticket.reply")}</Label>
          <textarea
            id={`hd-reply-${ticket.id}`}
            rows={2}
            maxLength={5000}
            className="mt-1.5 w-full rounded-md border border-input bg-background p-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          {post.isError ? (
            <div className="mt-2"><Notice tone="error">{mutationUserMessage(post.error)}</Notice></div>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={body.trim() === "" || post.isPending}
              onClick={() => {
                if (body.trim() === "") return;
                post.mutate(
                  { ticketId: ticket.id, body },
                  { onSuccess: () => { setBody(""); } },
                );
              }}
            >
              {post.isPending ? t("helpdesk.ticket.sending") : t("helpdesk.ticket.send")}
            </Button>

            {/*
              The two transitions trg_hdt__guard allows a requester. Reopening is
              offered only on a resolved ticket, cancelling only while it is
              still being worked — anything else raises 23514 server-side, and a
              button that exists to be refused is a button that should not exist.
            */}
            {ticket.status === "resolved" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={setStatus.isPending}
                onClick={() => setStatus.mutate({ ticketId: ticket.id, status: "open" })}
              >
                {t("helpdesk.ticket.reopen")}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={setStatus.isPending}
                onClick={() => setStatus.mutate({ ticketId: ticket.id, status: "cancelled" })}
              >
                {t("helpdesk.ticket.cancel")}
              </Button>
            )}
          </div>
          {setStatus.isError ? (
            <div className="mt-2"><Notice tone="error">{mutationUserMessage(setStatus.error)}</Notice></div>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("helpdesk.ticket.locked")}</p>
      )}
    </div>
  );
}

export default function HelpdeskPage() {
  const today = nowIstDate();

  // ── Document request (document_requests, migration 041000) ─────────────────
  const [kind, setKind] = useState<DocumentKind>("payslip");
  const [addressedTo, setAddressedTo] = useState("");
  const [note, setNote] = useState("");
  const [periodFrom, setPeriodFrom] = useState("");
  const [periodTo, setPeriodTo] = useState("");
  const [docSent, setDocSent] = useState<string | null>(null);
  const sendDoc = useSubmitDocumentRequest();
  const docAttempt = useSubmitAttempt();

  const periodic = PERIODIC_KINDS.includes(kind);

  const docBlockers: string[] = [];
  if (note.trim().length < 10) docBlockers.push(t("helpdesk.doc.blocked.note"));
  if (kind === "payslip" && periodFrom === "") docBlockers.push(t("helpdesk.doc.blocked.period"));
  if (periodFrom !== "" && periodFrom > today) docBlockers.push(t("helpdesk.doc.blocked.future"));
  if (periodTo !== "" && periodTo > today) docBlockers.push(t("helpdesk.doc.blocked.future"));
  if (periodFrom !== "" && periodTo !== "" && periodTo < periodFrom) {
    docBlockers.push(t("helpdesk.doc.blocked.order"));
  }

  // ── Tickets (helpdesk_tickets, migration 041500) ───────────────────────────
  const tickets = useMyTickets();
  const raise = useRaiseTicket();
  const ticketAttempt = useSubmitAttempt();
  const [desk, setDesk] = useState<HelpdeskDesk>("hr");
  const [priority, setPriority] = useState<HelpdeskPriority>("normal");
  const [subject, setSubject] = useState("");
  const [detail, setDetail] = useState("");
  const [ticketSent, setTicketSent] = useState<string | null>(null);
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);

  const ticketBlockers: string[] = [];
  if (subject.trim().length < 5) ticketBlockers.push(t("helpdesk.new.blocked.subject"));
  if (detail.trim().length < 10) ticketBlockers.push(t("helpdesk.new.blocked.detail"));

  /*
    One clock reading for the whole render. Calling Date.now() inside the column
    renderer would give two rows in the same table different "now"s, which is how
    a list ends up showing a ticket as breached in one column and not the other.
  */
  const nowMs = Date.now();

  const ticketColumns: DataGridColumn<HelpdeskTicket>[] = [
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
        title={t("helpdesk.title")}
        subtitle={t("helpdesk.subtitle")}
      />

      {/* ── Raise a ticket ───────────────────────────────────────────────── */}
      {ticketSent !== null ? (
        <div className="mt-4"><Notice tone="success">{t("helpdesk.new.done", { ref: ticketSent })}</Notice></div>
      ) : null}

      <section className="mt-4 rounded-lg border bg-card p-4" aria-labelledby="hd-new">
        <h2 id="hd-new" className="flex items-center gap-2 font-display text-lg font-semibold">
          <LifeBuoy className="size-4 text-muted-foreground" aria-hidden />
          {t("helpdesk.new.title")}
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{t("helpdesk.new.hint")}</p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="hd-desk">{t("helpdesk.new.desk")}</Label>
            <select
              id="hd-desk"
              value={desk}
              onChange={(e) => setDesk(e.target.value as HelpdeskDesk)}
              className="mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {helpdeskDeskValues.map((d) => (
                <option key={d} value={d}>{t(`helpdesk.desk.${d}` as MessageKey)}</option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="hd-priority">{t("helpdesk.new.priority")}</Label>
            <select
              id="hd-priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value as HelpdeskPriority)}
              className="mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {helpdeskPriorityValues.map((p) => (
                <option key={p} value={p}>{t(`helpdesk.priority.${p}` as MessageKey)}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-3">
          <Label htmlFor="hd-subject">{t("helpdesk.new.subject")}<Required /></Label>
          <Input
            id="hd-subject"
            className="mt-1.5 h-11"
            maxLength={200}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>

        <div className="mt-3">
          <Label htmlFor="hd-detail">{t("helpdesk.new.detail")}<Required /></Label>
          <textarea
            id="hd-detail"
            rows={3}
            maxLength={5000}
            className="mt-1.5 w-full rounded-md border border-input bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t("form.needTen")}</p>
        </div>

        {raise.isError ? (
          <div className="mt-3"><Notice tone="error">{mutationUserMessage(raise.error)}</Notice></div>
        ) : null}

        <SubmitBlockers
          attempt={ticketAttempt}
          blockers={ticketBlockers}
          id="hd-ticket-blockers"
          title={t("helpdesk.new.blocked.title")}
        />

        <Button
          className="mt-4 w-full"
          disabled={raise.isPending}
          {...blockerButtonProps(ticketAttempt, ticketBlockers, "hd-ticket-blockers")}
          onClick={() => {
            if (!ticketAttempt.press(ticketBlockers)) return;
            raise.mutate(
              { desk, priority, subject, description: detail },
              {
                onSuccess: (row) => {
                  setTicketSent(row.ticket_number);
                  setSubject("");
                  setDetail("");
                },
              },
            );
          }}
        >
          {raise.isPending ? t("helpdesk.new.sending") : t("helpdesk.new.send")}
        </Button>
      </section>

      {/* ── My tickets ───────────────────────────────────────────────────── */}
      <section className="mt-6" aria-labelledby="hd-mine">
        <h2 id="hd-mine" className="font-display text-lg font-semibold">
          {t("helpdesk.mine.title")}
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">{t("helpdesk.mine.hint")}</p>
        <StateBoundary
          loading={tickets.isLoading}
          error={tickets.error ?? undefined}
          onRetry={() => void tickets.refetch()}
        >
          <DataGrid
            columns={ticketColumns}
            rows={tickets.data ?? []}
            rowKey={(row) => row.id}
            pageSize={10}
            onRowClick={(row) => setOpenTicketId(openTicketId === row.id ? null : row.id)}
            renderRowDetail={(row) => (row.id === openTicketId ? <TicketDetail ticket={row} /> : null)}
            emptyState={
              <EmptyState
                icon={LifeBuoy}
                title={t("helpdesk.mine.empty.title")}
                hint={t("helpdesk.mine.empty.hint")}
              />
            }
          />
        </StateBoundary>
      </section>

      {/* ── Ask HR for a document ────────────────────────────────────────── */}
      {docSent !== null ? (
        <div className="mt-6"><Notice tone="success">{t("helpdesk.doc.done")}</Notice></div>
      ) : null}

      <section className="mt-6 rounded-lg border bg-card p-4" aria-labelledby="dr-form">
        <h2 id="dr-form" className="flex items-center gap-2 font-display text-lg font-semibold">
          <FileText className="size-4 text-muted-foreground" aria-hidden />
          {t("helpdesk.doc.title")}
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{t("helpdesk.doc.hint")}</p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="dr-kind">{t("helpdesk.doc.kind")}</Label>
            <select
              id="dr-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as DocumentKind)}
              className="mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {documentKindValues.map((v) => (
                <option key={v} value={v}>{t(`helpdesk.doc.kind.${v}` as MessageKey)}</option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="dr-to">{t("helpdesk.doc.addressedTo")}</Label>
            <Input
              id="dr-to"
              className="mt-1.5 h-11"
              maxLength={200}
              value={addressedTo}
              onChange={(e) => setAddressedTo(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">{t("helpdesk.doc.addressedTo.hint")}</p>
          </div>

          {/*
            Shown only for the kinds that cover a period. An address proof has no
            month, and a date box on it is a box people fill in wrongly.
          */}
          {periodic ? (
            <>
              <div>
                <Label htmlFor="dr-pf">{t("helpdesk.doc.periodFrom")}</Label>
                <Input
                  id="dr-pf"
                  type="date"
                  max={today}
                  className="mt-1.5 h-11"
                  value={periodFrom}
                  onChange={(e) => setPeriodFrom(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="dr-pt">{t("helpdesk.doc.periodTo")}</Label>
                <Input
                  id="dr-pt"
                  type="date"
                  max={today}
                  min={periodFrom === "" ? undefined : periodFrom}
                  className="mt-1.5 h-11"
                  value={periodTo}
                  onChange={(e) => setPeriodTo(e.target.value)}
                />
              </div>
            </>
          ) : null}
        </div>

        <div className="mt-3">
          <Label htmlFor="dr-note">{t("helpdesk.doc.note")}<Required /></Label>
          <textarea
            id="dr-note"
            rows={3}
            maxLength={1000}
            className="mt-1.5 w-full rounded-md border border-input bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t("form.needTen")}</p>
        </div>

        {sendDoc.isError ? (
          <div className="mt-3"><Notice tone="error">{mutationUserMessage(sendDoc.error)}</Notice></div>
        ) : null}

        <SubmitBlockers
          attempt={docAttempt}
          blockers={docBlockers}
          id="hd-doc-blockers"
          title={t("helpdesk.doc.blocked.title")}
        />

        <Button
          className="mt-4 w-full"
          disabled={sendDoc.isPending}
          {...blockerButtonProps(docAttempt, docBlockers, "hd-doc-blockers")}
          onClick={() => {
            if (!docAttempt.press(docBlockers)) return;
            sendDoc.mutate(
              {
                documentKind: kind,
                addressedTo,
                note,
                /*
                  Empty means "not asked for", which is NULL — not the empty
                  string, which `date` would reject, and not today, which would
                  silently answer a question the employee did not answer.
                */
                periodFrom: periodic && periodFrom !== "" ? periodFrom : null,
                periodTo: periodic && periodTo !== "" ? periodTo : null,
              },
              { onSuccess: (r) => { setDocSent(r.requestId); setNote(""); } },
            );
          }}
        >
          {sendDoc.isPending ? t("helpdesk.doc.sending") : t("helpdesk.doc.send")}
        </Button>

        <p className="mt-3 text-xs text-muted-foreground">{t("helpdesk.doc.track")}</p>
      </section>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("helpdesk.whenReady.title")}</CardTitle>
            <CardDescription>{t("helpdesk.whenReady.hint")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
              <li>{t("helpdesk.whenReady.item1")}</li>
              <li>{t("helpdesk.whenReady.item2")}</li>
              <li>{t("helpdesk.whenReady.item3")}</li>
              <li>{t("helpdesk.whenReady.item4")}</li>
              <li>{t("helpdesk.whenReady.item5")}</li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("helpdesk.today.title")}</CardTitle>
            <CardDescription>{t("helpdesk.today.hint")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button asChild variant="outline" className="w-full justify-start">
              <Link to="/me/apply">
                <ClipboardList className="mr-2 size-4" aria-hidden />
                {t("helpdesk.today.apply")}
              </Link>
            </Button>
            <Button asChild variant="outline" className="w-full justify-start">
              <Link to="/me/policies">
                <ScrollText className="mr-2 size-4" aria-hidden />
                {t("helpdesk.today.policies")}
              </Link>
            </Button>
            <Button asChild variant="outline" className="w-full justify-start">
              <Link to="/me/approvals">
                <ClipboardList className="mr-2 size-4" aria-hidden />
                {t("helpdesk.today.approvals")}
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
